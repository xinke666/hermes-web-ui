import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.fn()
const getSessionMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const getModelContextLengthMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const compressorCompressMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  getSession: getSessionMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    compress = compressorCompressMock
  },
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  bridgeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/message-format', () => ({
  isAssistantMessageSendable: vi.fn(() => true),
}))

describe('run chat compression trigger', () => {
  beforeEach(() => {
    getSessionDetailMock.mockReset()
    getSessionMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    getModelContextLengthMock.mockReset()
    calcAndUpdateUsageMock.mockReset()
    compressorCompressMock.mockReset()

    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default' })
    getModelContextLengthMock.mockReturnValue(200_000)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    getCompressionSnapshotMock.mockReturnValue(null)
  })

  it('does not compress long low-token history just because it has more than 150 messages', async () => {
    const messages = Array.from({ length: 152 }, (_, index) => ({
      id: index + 1,
      session_id: 'session-1',
      role: index === 151 ? 'user' : index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`,
      timestamp: index + 1,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      finish_reason: null,
      reasoning_content: null,
    }))
    getSessionDetailMock.mockReturnValue({ messages })

    const { buildCompressedHistory } = await import('../../packages/server/src/services/hermes/run-chat/compression')
    const history = await buildCompressedHistory(
      'session-1',
      'default',
      'http://upstream',
      undefined,
      vi.fn(),
      new Map(),
    )

    expect(history).toHaveLength(151)
    expect(history[0]).toEqual({ role: 'user', content: 'm0' })
    expect(history.at(-1)).toEqual({ role: 'user', content: 'm150' })
    expect(compressorCompressMock).not.toHaveBeenCalled()
  })
})
