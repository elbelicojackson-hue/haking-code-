import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { isTodoV2Enabled } from 'src/utils/tasks.js'
import { TodoListSchema } from 'src/utils/todo/types.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    todos: TodoListSchema().describe('The updated todo list'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    oldTodos: TodoListSchema().describe('The todo list before the update'),
    newTodos: TodoListSchema().describe('The todo list after the update'),
    verificationNudgeNeeded: z.boolean().optional(),
    hasInProgressViolation: z.boolean().optional(),
    batchCompletionDetected: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  searchHint: 'manage the session task checklist',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    return !isTodoV2Enabled()
  },
  toAutoClassifierInput(input) {
    return `${input.todos.length} items`
  },
  async checkPermissions(input) {
    // No permission checks required for todo operations
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ todos }, context) {
    const appState = context.getAppState()
    const todoKey = context.agentId ?? getSessionId()
    const oldTodos = appState.todos[todoKey] ?? []
    const allDone = todos.every(_ => _.status === 'completed')
    const newTodos = allDone ? [] : todos

    // ── Runtime validations (CC2.0 parity) ──────────────────────────────

    // V1: Exactly one in_progress at a time
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length
    const hasInProgressViolation = !allDone && inProgressCount !== 1

    // V2: No batch completions — detect multiple tasks flipping to completed
    // in a single call (should complete one at a time)
    const prevPending = new Set(
      oldTodos.filter(t => t.status !== 'completed').map(t => t.content),
    )
    const newlyCompleted = todos.filter(
      t => t.status === 'completed' && prevPending.has(t.content),
    )
    const batchCompletionDetected = newlyCompleted.length > 1

    // V3: Structural nudge for verification step
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      allDone &&
      todos.length >= 3 &&
      !todos.some(t => /verif/i.test(t.content))
    ) {
      verificationNudgeNeeded = true
    }

    context.setAppState(prev => ({
      ...prev,
      todos: {
        ...prev.todos,
        [todoKey]: newTodos,
      },
    }))

    return {
      data: {
        oldTodos,
        newTodos: todos,
        verificationNudgeNeeded,
        hasInProgressViolation,
        batchCompletionDetected,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    { verificationNudgeNeeded, hasInProgressViolation, batchCompletionDetected },
    toolUseID,
  ) {
    const parts: string[] = [
      'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
    ]

    if (hasInProgressViolation) {
      parts.push(
        '\n\n⚠️ VIOLATION: Exactly ONE task must be in_progress at all times (not zero, not multiple). Fix this immediately.',
      )
    }
    if (batchCompletionDetected) {
      parts.push(
        '\n\n⚠️ WARNING: Multiple tasks were completed in a single update. Complete tasks ONE AT A TIME — mark each as completed immediately after finishing, before starting the next.',
      )
    }
    if (verificationNudgeNeeded) {
      parts.push(
        `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`,
      )
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: parts.join(''),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
