type Metrics = {
  requests: number
  errors: number
  llmCalls: number
  llmDurationMs: number
}

const metrics: Metrics = {
  requests: 0,
  errors: 0,
  llmCalls: 0,
  llmDurationMs: 0,
}

export const recordRequest = () => {
  metrics.requests += 1
}

export const recordError = () => {
  metrics.errors += 1
}

export const recordLlmCall = (durationMs: number) => {
  metrics.llmCalls += 1
  metrics.llmDurationMs += durationMs
}

export const getMetricsSnapshot = () => ({
  ...metrics,
  llmAvgMs: metrics.llmCalls ? Math.round(metrics.llmDurationMs / metrics.llmCalls) : 0,
})

setInterval(() => {
  const snapshot = getMetricsSnapshot()
  console.log('[metrics]', snapshot)
}, 60000)
