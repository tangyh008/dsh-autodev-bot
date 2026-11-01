/**
 * @local/dsh-autodev-bot — Host half.
 *
 * Team preset bridge. DSH's `spawn_teammate` tool has no Agent preset
 * parameter, so every teammate joins the Lead's composition (persona, tools,
 * skills) and the 5-role DevBot design cannot give a teammate its own preset.
 * This plugin wraps the public `ctx.subagents.startActivation` service method
 * and supplies `request.agentPreset` for a fresh teammate when all of these
 * hold:
 * - the spawning parent runs a DevBot preset (`composedPreset` starts with
 *   `devbot-`);
 * - the spawn text carries an explicit `devbot_role=<role>` tag;
 * - the target provider advertises `capabilities.agentPreset` and does not
 *   inherit the parent conversation;
 * - the caller did not already select a preset.
 *
 * The tag is the only opt-in: other Teams and other plugins are untouched, and
 * a spawn without the tag keeps inheriting the Lead composition exactly as
 * before. If a future DSH changes the method shape, the wrapper logs a warning
 * and every spawn keeps the previous inheritance behavior; the bridge must
 * never make teammate creation fail.
 */

/** Role tag → Agent preset id. Keep the ids in sync with cordis.patch.yml. */
const ROLE_PRESETS = Object.freeze({
  pm: 'devbot-pm',
  designer: 'devbot-designer',
  fullstack: 'devbot-fullstack',
  tester: 'devbot-tester',
  lead: 'devbot-lead',
})

/** Explicit role tag accepted in a spawn description or prompt, e.g. `devbot_role=pm`. */
const ROLE_TAG = /devbot_role\s*[:=：]\s*(pm|designer|fullstack|tester|lead)\b/iu

/** Services required by the bridge. */
export const inject = ['subagents']

/** Prevent a second patch when the plugin reloads or two entries mount it. */
const PATCHED = new WeakSet()

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  installBridge(ctx)
}

/**
 * Wrap the subagent activation entry point once per live service instance.
 * @param {any} ctx - root Cordis context.
 */
function installBridge(ctx) {
  try {
    const service = ctx.subagents
    if (service === undefined || typeof service.startActivation !== 'function') return
    if (PATCHED.has(service)) return
    const original = service.startActivation
    const patched = function devbotStartActivation(spec) {
      let next = spec
      try {
        next = withTeammatePreset(ctx, service, spec)
      } catch (error) {
        try { ctx.logger.warn('[devbot] teammate preset bridge skipped one spawn: ' + String(error)) } catch (ignored) { /* logging must not fail */ }
      }
      return original.call(this, next)
    }
    service.startActivation = patched
    PATCHED.add(service)
    ctx.effect(() => () => {
      if (service.startActivation === patched) service.startActivation = original
      PATCHED.delete(service)
    }, 'devbot: teammate preset bridge')
    log(ctx, 'info', '[devbot] teammate preset bridge installed')
  } catch (error) {
    log(ctx, 'warn', '[devbot] teammate preset bridge unavailable; teammates inherit the Lead preset: ' + String(error))
  }
}

/**
 * Return the activation spec with a role preset, or the original spec unchanged.
 * @param {any} ctx - root Cordis context.
 * @param {any} service - live `ctx.subagents` service.
 * @param {any} spec - one `startActivation` argument.
 * @returns {any} the spec to start, original identity when untouched.
 */
function withTeammatePreset(ctx, service, spec) {
  if (spec === null || typeof spec !== 'object') return spec
  const request = spec.request
  if (request === null || typeof request !== 'object') return spec
  if (request.agentPreset !== undefined) return spec
  if (typeof spec.provider !== 'string') return spec
  const provider = typeof service.getProvider === 'function' ? service.getProvider(spec.provider) : undefined
  if (provider === undefined) return spec
  if (provider.capabilities === undefined || provider.capabilities.agentPreset !== true) return spec
  if (provider.inheritsParentContext !== false) return spec
  const parentPreset = composedPreset(request.parent)
  if (typeof parentPreset !== 'string' || !parentPreset.startsWith('devbot-')) return spec
  const role = roleOf(spec)
  if (role === undefined) return spec
  const preset = ROLE_PRESETS[role]
  if (preset === undefined) return spec
  log(ctx, 'info', '[devbot] teammate preset bridge: ' + (typeof spec.label === 'string' ? spec.label : 'teammate') + ' -> ' + preset)
  return { ...spec, request: { ...request, agentPreset: preset } }
}

/**
 * Read the parent Agent's composed preset id without widening the service API.
 * @param {any} parent - spawning Agent.
 * @returns {string | undefined} composed preset id.
 */
function composedPreset(parent) {
  const parentCtx = parent === null || parent === undefined ? undefined : parent.ctx
  if (parentCtx === undefined || typeof parentCtx.get !== 'function') return undefined
  const presets = parentCtx.get('agentPresets')
  if (presets === undefined || typeof presets.composedPreset !== 'function') return undefined
  return presets.composedPreset(parentCtx)
}

/**
 * Extract the role tag from the spawn description or prompt text.
 * @param {any} spec - activation spec.
 * @returns {string | undefined} one canonical role id.
 */
function roleOf(spec) {
  const text = [typeof spec.label === 'string' ? spec.label : '', promptText(spec.request.prompt)].join('\n')
  const match = ROLE_TAG.exec(text)
  return match === null ? undefined : match[1].toLowerCase()
}

/**
 * Join the text blocks of one subagent prompt.
 * @param {unknown} prompt - `ContentBlock[]` from the activation request.
 * @returns {string} model-visible text.
 */
function promptText(prompt) {
  if (!Array.isArray(prompt)) return ''
  const parts = []
  for (const block of prompt) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Log without letting a missing or failing logger affect the bridge.
 * @param {any} ctx - root Cordis context.
 * @param {'info' | 'warn'} level - logger level.
 * @param {string} message - line to write.
 */
function log(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
  } catch (ignored) { /* logging is best effort */ }
}
