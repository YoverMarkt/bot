-- ============================================================
-- El comprobante se LEE y se puntúa
-- ============================================================
--
-- ⚠️ SE LLAMA «lectura» Y NO «analisis», Y NO ES CAPRICHO. El ejecutor de
-- migraciones ordena alfabéticamente entre las de la misma fecha
-- (`tests/migraciones.mjs`, `a.localeCompare(b)`), y esta DEPENDE de
-- `migration-2026-08-22-huella-del-comprobante.sql`, que crea las tablas.
-- Con el nombre `analisis-…` ordenaba ANTES que ella y sobre una base
-- reconstruida desde cero reventaba con «relation payment_receipts does not
-- exist». La 'l' ordena después de la 'h'.
--
-- Es la TERCERA vez que esta trampa aparece (ver
-- `migration-2026-08-21-marketplace-busqueda.sql`, renombrada por lo mismo).
-- El CI no puede verla: aplica `schema.sql` entero sobre una base vacía, así
-- que nunca reproduce la cadena y saldría verde sobre una ficción. No lo
-- «arregles» renombrando de vuelta.
--
-- El PR A (migration-2026-08-22-huella-del-comprobante.sql) dejó la mesa
-- puesta: `payment_receipts` ya tiene las columnas donde va lo que se extraiga
-- de la imagen y su riesgo, y `payment_receipt_risk_flags` ya guarda una señal
-- por fila con sus puntos. Lo que faltaba era quien las llenara.
--
-- Esto añade las DOS funciones que faltan y NADA más:
--
--   · `save_receipt_analysis`  — escribe lo leído, sus señales y su score.
--   · `get_receipt_analysis`   — lo que el panel del dueño enseña.
--
-- ⚠️ REGLA QUE NO SE NEGOCIA, y está comprobada en las pruebas: **nada de esto
-- confirma un pago**. Ninguna de las dos funciones escribe una sola columna de
-- `orders` — ni `payment_confirmed_at`, ni `status`. Un comprobante que «parece
-- auténtico» sigue siendo una imagen: pudo editarse, generarse o reutilizarse.
-- El pago lo da por bueno el dueño desde su panel, mirando su banco.
--
-- ⚠️ Y es ADITIVA como la anterior: `orders.payment_proof_url` se queda,
-- `attach_storefront_payment_proof` no se toca, y con el análisis apagado —que
-- es como nace— el flujo de siempre no cambia en absolutamente nada.

-- ── 1. Guardar lo que se leyó de la imagen ───────────────────────────
--
-- Todo en UNA operación: los campos, las señales, el score recalculado y la
-- auditoría. Separado en cuatro consultas, un fallo a mitad dejaría un
-- comprobante con datos pero sin score, o con score pero sin las señales que
-- lo explican — que es la peor forma de enseñar un número.
--
-- ⚠️ EL SCORE SE RECALCULA SUMANDO **TODAS** LAS SEÑALES DEL COMPROBANTE, no
-- solo las que llegan en esta llamada. Es deliberado y es la razón de que se
-- calcule aquí y no en el servidor: `register_payment_receipt` ya escribió la
-- señal de duplicado —70 puntos si es el mismo archivo, 60 si es la misma
-- imagen— ANTES de que el análisis existiera, precisamente para que un
-- duplicado quede marcado aunque el análisis esté apagado o falle. Si el
-- servidor mandara un total calculado por su cuenta, esos puntos se perderían
-- y un comprobante reutilizado podría salir «bajo».
--
-- ⚠️ LOS TEXTOS SE RECORTAN EN VEZ DE RECHAZARSE. Los CHECK de la tabla
-- limitan cada campo (120 el banco, 160 los nombres, 8000 el texto crudo…), y
-- un modelo de visión sobre una foto ruidosa puede devolver cualquier cosa.
-- Abortar por un nombre de banco de 300 caracteres perdería el análisis
-- ENTERO, incluidas las señales de riesgo, que es justo lo que hay que
-- conservar. El servidor ya sanea; esto es la última red.
create or replace function public.save_receipt_analysis(
  p_business_id uuid,
  p_receipt_id uuid,
  p_status text,
  p_datos jsonb default null,
  p_flags jsonb default null,
  p_analysis jsonb default null,
  p_puntos_referencia integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existe boolean;
  v_fecha date;
  v_hora time;
  v_monto numeric(12,2);
  v_flag jsonb;
  v_score integer;
  v_nivel text;
  v_estado_previo text;
  v_referencia text;
  v_ref_repetida integer := 0;
begin
  if p_business_id is null or p_receipt_id is null then
    raise exception using errcode = '22023', message = 'Faltan el negocio o el comprobante';
  end if;

  -- Solo dos destinos posibles, y ninguno dice que el dinero llegó:
  -- `analizado` = se pudo leer; `requiere_revision` = no se pudo, lo mira una
  -- persona. Los otros dos estados de la tabla los pone otro camino
  -- (`pendiente_analisis` al recibirlo, `descartado` al pedir otro).
  if p_status is null or p_status not in ('analizado', 'requiere_revision') then
    raise exception using errcode = '22023',
      message = 'El analisis solo puede dejar el comprobante en analizado o requiere_revision';
  end if;

  -- El comprobante tiene que ser de ESTE negocio. Sin esto, un identificador
  -- ajeno dejaría escrito el análisis de otro local — y devolvería sus datos.
  select true, r.status into v_existe, v_estado_previo
  from public.payment_receipts r
  where r.id = p_receipt_id and r.business_id = p_business_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── Las conversiones que pueden reventar ──
  --
  -- Un modelo puede devolver «32/13/2026», «ayer» o un monto con letras. Un
  -- cast directo abortaría la transacción entera y se perdería todo lo demás,
  -- incluido el texto crudo, que es lo que permite entender QUÉ leyó. Cada
  -- una va en su propio bloque: lo que no se entienda se queda nulo, que es
  -- exactamente lo que significa «no se pudo leer ese dato».
  begin
    v_fecha := nullif(btrim(p_datos->>'transaction_date'), '')::date;
  exception when others then
    v_fecha := null;
  end;
  begin
    v_hora := nullif(btrim(p_datos->>'transaction_time'), '')::time;
  exception when others then
    v_hora := null;
  end;
  begin
    v_monto := nullif(btrim(p_datos->>'amount'), '')::numeric(12,2);
    -- El CHECK de la tabla exige 0..999999. Fuera de rango es un dato mal
    -- leído, no un pago de un millón: se descarta el campo, no el análisis.
    if v_monto is not null and (v_monto < 0 or v_monto > 999999) then
      v_monto := null;
    end if;
  exception when others then
    v_monto := null;
  end;

  update public.payment_receipts r set
    bank_name           = left(nullif(btrim(p_datos->>'bank_name'), ''), 120),
    sender_name         = left(nullif(btrim(p_datos->>'sender_name'), ''), 160),
    beneficiary_name    = left(nullif(btrim(p_datos->>'beneficiary_name'), ''), 160),
    destination_account = left(nullif(btrim(p_datos->>'destination_account'), ''), 60),
    amount              = v_monto,
    currency            = left(nullif(btrim(p_datos->>'currency'), ''), 8),
    transaction_date    = v_fecha,
    transaction_time    = v_hora,
    reference_number    = left(nullif(btrim(p_datos->>'reference_number'), ''), 80),
    transaction_number  = left(nullif(btrim(p_datos->>'transaction_number'), ''), 80),
    ocr_raw_text        = left(nullif(btrim(p_datos->>'ocr_raw_text'), ''), 8000),
    analysis_json       = p_analysis,
    status              = p_status,
    updated_at          = now()
  where r.id = p_receipt_id and r.business_id = p_business_id;

  -- ── Las señales ──
  --
  -- Una fila por señal, con sus puntos, para que el score se pueda explicar:
  -- sin esto, un 78/100 es un número sin defensa delante de un dueño que está
  -- decidiendo si entrega comida sin haber cobrado.
  if p_flags is not null and jsonb_typeof(p_flags) = 'array' then
    for v_flag in select * from jsonb_array_elements(p_flags) loop
      -- Una señal mal formada se ignora en vez de tumbar el análisis: el resto
      -- de señales y los campos leídos valen más que la que vino rota.
      continue when jsonb_typeof(v_flag) <> 'object';
      continue when coalesce(btrim(v_flag->>'flag_type'), '') = '';

      insert into public.payment_receipt_risk_flags (
        business_id, receipt_id, flag_type, severity, description, points
      ) values (
        p_business_id,
        p_receipt_id,
        left(btrim(v_flag->>'flag_type'), 60),
        case
          when v_flag->>'severity' in ('baja', 'media', 'alta', 'critica')
            then v_flag->>'severity'
          else 'media'
        end,
        left(nullif(btrim(v_flag->>'description'), ''), 300),
        -- Fuera del rango del CHECK (−100..100) se acota en vez de abortar.
        greatest(-100, least(100, coalesce(
          (case when v_flag->>'points' ~ '^-?[0-9]{1,4}$'
                then (v_flag->>'points')::integer end), 0
        )))
      );
    end loop;
  end if;

  -- ── ¿Esta referencia bancaria ya se usó? ──
  --
  -- Es el duplicado que la huella NO puede ver: quien vuelve a mandar el mismo
  -- pago recorta la captura, le cambia el brillo o la reenvía por WhatsApp —y
  -- entonces el SHA cambia y hasta el perceptual puede fallar—, pero el número
  -- de transacción del banco sigue siendo el mismo. Es el mismo dinero contado
  -- dos veces.
  --
  -- ⚠️ La búsqueda es GLOBAL, como la de la huella y por lo mismo: una
  -- referencia reutilizada en OTRO local es el fraude que más pesa y limitarla
  -- a este negocio lo dejaría pasar. Y como allí, lo que se ESCRIBE no nombra
  -- al otro negocio: la señal dice que ya se usó, nunca dónde.
  select nullif(btrim(p_datos->>'reference_number'), '') into v_referencia;
  if v_referencia is not null and p_puntos_referencia <> 0 then
    select count(*) into v_ref_repetida
    from public.payment_receipts r
    where r.reference_number = v_referencia
      and r.id <> p_receipt_id
      -- Del mismo pedido no cuenta: es el cliente reenviando su propio
      -- comprobante porque el primero salió borroso, que no es fraude.
      and r.order_id <> (
        select order_id from public.payment_receipts where id = p_receipt_id
      );

    if v_ref_repetida > 0 then
      insert into public.payment_receipt_risk_flags (
        business_id, receipt_id, flag_type, severity, description, points
      ) values (
        p_business_id, p_receipt_id, 'referencia_duplicada', 'critica',
        format('La referencia %s ya se usó en otro pedido', v_referencia),
        greatest(-100, least(100, p_puntos_referencia))
      );
    end if;
  end if;

  -- ── El score, sumando TODO lo que hay escrito sobre este comprobante ──
  --
  -- Acotado a 0..100: las señales que restan (monto que coincide, cuenta que
  -- coincide) no pueden llevar el riesgo por debajo de cero, y varias señales
  -- graves juntas no pueden pasar de cien. Las bandas son las del encargo.
  select greatest(0, least(100, coalesce(sum(f.points), 0)))
  into v_score
  from public.payment_receipt_risk_flags f
  where f.receipt_id = p_receipt_id and f.business_id = p_business_id;

  v_nivel := case
    when v_score <= 20 then 'bajo'
    when v_score <= 50 then 'medio'
    when v_score <= 75 then 'alto'
    else 'critico'
  end;

  update public.payment_receipts r
     set risk_score = v_score, risk_level = v_nivel, updated_at = now()
   where r.id = p_receipt_id and r.business_id = p_business_id;

  insert into public.payment_receipt_audit_logs (
    business_id, receipt_id, action, old_status, new_status, metadata
  ) values (
    p_business_id, p_receipt_id, 'analizado', v_estado_previo, p_status,
    jsonb_build_object(
      'risk_score', v_score,
      'risk_level', v_nivel,
      'senales', (
        select count(*) from public.payment_receipt_risk_flags f
        where f.receipt_id = p_receipt_id
      )
    )
  );

  return jsonb_build_object(
    'result', 'saved',
    'receipt_id', p_receipt_id,
    'risk_score', v_score,
    'risk_level', v_nivel
  );
end;
$$;

revoke all on function public.save_receipt_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.save_receipt_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, integer
) to service_role;

-- ── 2. Lo que ve el dueño ────────────────────────────────────────────
--
-- El comprobante MÁS RECIENTE de un pedido, con sus señales. Va en una función
-- y no en dos consultas desde el servidor por dos motivos: el filtro por
-- negocio queda dentro (un identificador de pedido viaja en la URL, y sin el
-- negocio se estaría enseñando el comprobante de otro local), y las señales
-- llegan en la misma ida y vuelta que el comprobante — el panel del dueño
-- recarga sus pedidos cada 12 segundos y no conviene duplicarle las consultas.
--
-- ⚠️ NUNCA devuelve nada de otro negocio. La detección de duplicados sí mira
-- toda la plataforma —un comprobante reutilizado en otro local es el fraude
-- que más pesa—, pero lo que sale de aquí es solo de este dueño: la señal dice
-- que esa imagen ya se usó, y el pedido que nombra es de su propio negocio o
-- de ninguno. Es el mismo criterio de `register_payment_receipt`.
create or replace function public.get_receipt_analysis(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'receipt_id', r.id,
        'status', r.status,
        'bank_name', r.bank_name,
        'sender_name', r.sender_name,
        'beneficiary_name', r.beneficiary_name,
        'destination_account', r.destination_account,
        'amount', r.amount,
        'currency', r.currency,
        'transaction_date', r.transaction_date,
        'transaction_time', r.transaction_time,
        'reference_number', r.reference_number,
        'transaction_number', r.transaction_number,
        'risk_score', r.risk_score,
        'risk_level', r.risk_level,
        'created_at', r.created_at,
        'flags', coalesce((
          select jsonb_agg(jsonb_build_object(
            'flag_type', f.flag_type,
            'severity', f.severity,
            'description', f.description,
            'points', f.points
          ) order by f.points desc, f.created_at)
          from public.payment_receipt_risk_flags f
          where f.receipt_id = r.id and f.business_id = p_business_id
        ), '[]'::jsonb)
      )
      from public.payment_receipts r
      where r.order_id = p_order_id
        and r.business_id = p_business_id
      order by r.created_at desc
      limit 1
    ),
    -- Sin comprobante registrado no es un error: son todos los pedidos
    -- anteriores a esta capa, y el panel tiene que saber pintarlos igual.
    jsonb_build_object('result', 'sin_analisis')
  );
$$;

revoke all on function public.get_receipt_analysis(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_receipt_analysis(uuid, uuid) to service_role;
