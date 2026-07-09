// ── ESLint (barandilla de la migración) ──────────────────────────────
// Caza errores reales (variables inexistentes, redeclaraciones) sin pelear
// con el estilo del código existente. Los archivos legacy grandes se van
// limpiando al migrarlos a services/ (ver ARQUITECTURA.md).
const globals = require('globals')

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // Errores reales (rompen en producción) → bloquean
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-redeclare': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // Higiene (no rompen) → avisan sin bloquear
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    // Los tests (Vitest) son ESM: usan import/export
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    }
  }
]
