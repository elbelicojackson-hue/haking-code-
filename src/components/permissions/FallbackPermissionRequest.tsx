import React, { useCallback, useMemo } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Box, Text, useTheme } from '@anthropic/ink'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { env } from '../../utils/env.js'
import { logForDebugging } from '../../utils/debug.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { logUnaryEvent } from '../../utils/unaryLogging.js'
import { type UnaryEvent, usePermissionRequestLogging } from './hooks.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from './PermissionPrompt.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'

type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [theme] = useTheme()
  // Guard: tool may be a third-party / MCP / test stub that doesn't fully
  // implement the Tool interface. Prefer a fallback over crashing the entire
  // permission dialog (which leaves the agent waiting forever).
  const originalUserFacingName = safeUserFacingName(
    toolUseConfirm.tool,
    toolUseConfirm.input,
  )
  const userFacingName = originalUserFacingName.endsWith(' (MCP)')
    ? originalUserFacingName.slice(0, -6)
    : originalUserFacingName

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleSelect = useCallback(
    (value: FallbackOptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id!,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-dont-ask-again': {
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id!,
              platform: env.platform,
            },
          })

          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                {
                  toolName: toolUseConfirm.tool.name,
                },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        }
        case 'no':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id!,
              platform: env.platform,
            },
          })
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    void logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id!,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  const originalCwd = getOriginalCwd()
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()
  const options = useMemo((): PermissionPromptOption<FallbackOptionValue>[] => {
    const result: PermissionPromptOption<FallbackOptionValue>[] = [
      {
        label: 'Yes',
        value: 'yes',
        feedbackConfig: { type: 'accept' },
      },
    ]

    if (showAlwaysAllowOptions) {
      result.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{userFacingName}</Text>{' '}
            commands in <Text bold>{originalCwd}</Text>
          </Text>
        ),
        value: 'yes-dont-ask-again',
      })
    }

    result.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })

    return result
  }, [userFacingName, originalCwd, showAlwaysAllowOptions])

  const toolAnalyticsContext = useMemo(
    (): ToolAnalyticsContext => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  return (
    <PermissionDialog title="Tool use" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {userFacingName}(
          {safeRenderToolUseMessage(toolUseConfirm.tool, toolUseConfirm.input, {
            theme,
            verbose: true,
          })}
          )
          {originalUserFacingName.endsWith(' (MCP)') ? (
            <Text dimColor> (MCP)</Text>
          ) : (
            ''
          )}
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}



/**
 * Best-effort tool-name renderer. Some tool objects in the wild
 * (third-party MCP servers, test stubs, partially-loaded modules from
 * circular requires) don't fully implement the Tool interface. Crashing
 * the entire permission dialog because of a missing method leaves the
 * agent stuck waiting for a user decision that can never arrive — fall
 * back to the bare tool name instead.
 */
function safeUserFacingName(tool: unknown, input: unknown): string {
  const t = tool as {
    name?: string
    userFacingName?: (input: never) => string
  }
  if (typeof t.userFacingName === 'function') {
    try {
      return t.userFacingName(input as never)
    } catch (err) {
      logForDebugging(
        `FallbackPermissionRequest: userFacingName threw for ${t.name ?? 'unknown'}: ${err}`,
        { level: 'warn' },
      )
    }
  }
  return t.name ?? 'unknown'
}

/**
 * Best-effort tool input renderer. Same rationale as safeUserFacingName.
 * When the method is missing or throws, fall back to a one-line JSON
 * preview of the raw input so the user still has *something* to base
 * their permission decision on.
 */
function safeRenderToolUseMessage(
  tool: unknown,
  input: unknown,
  options: { theme: unknown; verbose: boolean },
): React.ReactNode {
  const t = tool as {
    name?: string
    renderToolUseMessage?: (
      input: never,
      options: { theme: unknown; verbose: boolean },
    ) => React.ReactNode
  }
  if (typeof t.renderToolUseMessage === 'function') {
    try {
      return t.renderToolUseMessage(input as never, options)
    } catch (err) {
      logForDebugging(
        `FallbackPermissionRequest: renderToolUseMessage threw for ${t.name ?? 'unknown'}: ${err}`,
        { level: 'warn' },
      )
    }
  } else {
    logForDebugging(
      `FallbackPermissionRequest: tool '${t.name ?? 'unknown'}' has no renderToolUseMessage; using JSON fallback`,
      { level: 'warn' },
    )
  }
  return formatInputFallback(input)
}

const FALLBACK_INPUT_MAX_CHARS = 120

function formatInputFallback(input: unknown): string {
  if (input == null) return ''
  let raw: string
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    raw = String(input)
  }
  if (raw.length > FALLBACK_INPUT_MAX_CHARS) {
    return raw.slice(0, FALLBACK_INPUT_MAX_CHARS - 1) + '…'
  }
  return raw
}
