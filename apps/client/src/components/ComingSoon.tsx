// Placeholder de secciones aún no migradas (patrón estrangulador):
// mientras tanto, el dueño las usa en el panel actual (/client).
export default function ComingSoon({ title }: { title: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-stone-900 mb-2">{title}</h1>
      <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
        <div className="text-4xl mb-3">🚧</div>
        <p className="text-stone-700 font-medium">Esta sección se está migrando al panel nuevo.</p>
        <p className="text-sm text-stone-500 mt-1">
          Mientras tanto, sigue usándola en el{' '}
          <a href="/client" className="text-green-700 font-semibold underline">panel actual</a>.
        </p>
      </div>
    </div>
  )
}
