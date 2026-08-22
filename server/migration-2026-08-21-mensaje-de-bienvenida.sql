-- ═══════════════════════════════════════════════════════════════════════════
-- EL DUEÑO ESCRIBE UNA BIENVENIDA, NO UN PROMPT
--
-- Con la IA retirada, `bot_policies.bot_prompt` dejó de ser un prompt: lo único
-- que seguía haciendo era alimentar el saludo del modo menú. Y lo hacía de una
-- forma que solo tenía sentido mientras existiera un modelo — MINANDO el texto
-- con expresiones regulares:
--
--     /(?:saludo inicial|siempre saluda con)\s*:?\s*"([^"]{1,255})"/
--     /^\s*eres\s+([^,\n.]{2,40}),\s+((?:el|la)\s+[^,\n.]{2,140})/
--
-- O sea: el dueño escribía instrucciones para una IA y el código pescaba de ahí
-- un saludo. Ahora escribe el saludo, y se muestra tal cual.
--
-- ⚠️ El límite de repetición de una regex en PostgreSQL es 255, no más. Con
-- `{1,280}` la conversión revienta con «invalid repetition count(s)» — y solo
-- cuando hay datos, porque sin filas que casen el `where` la expresión ni se
-- evalúa. Un ensayo sobre una base vacía lo da por bueno.
--
-- ⚠️ LA CONVERSIÓN NO COPIA EL PROMPT ENTERO. Un prompt son párrafos de
-- instrucciones; puesto de saludo, el cliente recibiría el manual del bot como
-- primer mensaje. Se extrae lo MISMO que extraía el código —así nadie ve un
-- saludo distinto al de ayer— y lo que no dé un saludo se queda en nulo, que
-- cae al de por defecto.
--
-- ⚠️ `bot_instructions` se va sin conversión: era exclusivamente para la IA
-- («INSTRUCCIONES ADICIONALES DEL DUEÑO» dentro del prompt) y nada más lo leía.
--
-- ⚠️ `shipping`, `returns` y `discounts` SE QUEDAN. Son texto que escribe el
-- dueño sobre envíos, devoluciones y descuentos, y se pueden mostrar tal cual.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.bot_policies
  add column if not exists welcome_message text;

comment on column public.bot_policies.welcome_message is
  'El saludo que el negocio manda al cliente cuando abre conversación. Se '
  'muestra TAL CUAL, sin pasar por ningún modelo. Admite {{negocio}}. Vacío = '
  'se usa el saludo por defecto.';

-- La conversión, con las mismas dos reglas que usaba el código.
update public.bot_policies
   set welcome_message = coalesce(
     -- 1. Un saludo entrecomillado y explícito.
     substring(
       bot_prompt from
       '(?i)(?:saludo\s+inicial|siempre\s+saluda\s+con)\s*:?\s*"([^"]{1,255})"'
     ),
     -- 2. Si no, la identidad declarada: «Eres Andrea, la asistente de…».
     case
       when bot_prompt ~* '(^|\n)\s*eres\s+[^,\n.]{2,40},\s+(el|la)\s+[^,\n.]{2,140}'
       then '¡Hola! 👋 Soy '
         || substring(bot_prompt from '(?i)(?:^|\n)\s*eres\s+([^,\n.]{2,40}),')
         || ', '
         || substring(bot_prompt from '(?i)(?:^|\n)\s*eres\s+[^,\n.]{2,40},\s+((?:el|la)\s+[^,\n.]{2,140})')
         || '. Es un gusto atenderle 😊'
       else null
     end
   )
 where nullif(btrim(coalesce(bot_prompt, '')), '') is not null;

-- Un saludo no son párrafos: si la conversión sacó algo desmedido, mejor nulo
-- —y el de por defecto— que soltarle al cliente media página.
update public.bot_policies
   set welcome_message = null
 where char_length(coalesce(welcome_message, '')) > 280;

alter table public.bot_policies
  add constraint bot_policies_welcome_check check (
    welcome_message is null or char_length(welcome_message) <= 280
  );

alter table public.bot_policies
  drop column if exists bot_prompt,
  drop column if exists bot_instructions;
