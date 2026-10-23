// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
  },
  {
    // Hook commands spell out `${CLAUDE_PLUGIN_ROOT}` literally: Claude Code
    // expands it, not JavaScript.
    files: ['test/**/*.ts'],
    rules: {
      'no-template-curly-in-string': 'off',
    },
  },
)
