// 速度口径回归：耗时用 step/start → 消息落盘（含首字延迟），不是 dt[] 跨度
import assert from 'node:assert/strict'
import test from 'node:test'
import { foldRate } from '../lib/mod/rate.js'

const T = 1_000_000
const msg = (at, outTokens, time0, dt) => ({
  type: 'assistant/message',
  time: at,
  data: { usage: { outputTokens: outTokens }, stream: [{ chunk: { type: 'text-chunks', time0, dt } }] }
})

test('包含首字延迟的真实耗时（3.2s / 100 tok ≈ 31 tok/s）', () => {
  const r = foldRate([{ type: 'step/start', time: T }, msg(T + 3200, 100, T + 2950, [120, 130])], T + 3300)
  assert.equal(Math.round(r.speed), 31)
})

test('重试从重试起点重新计时', () => {
  const ev = [{ type: 'step/start', time: T }, { type: 'llm/retry-started', time: T + 5000 }, msg(T + 6000, 200, T + 5800, [100])]
  assert.equal(Math.round(foldRate(ev, T + 6100).speed), 200)
})

test('排队/退避产生的超长样本丢弃', () => {
  const ev = [{ type: 'step/start', time: T }, msg(T + 125_000, 219, T + 124_500, [400])]
  assert.equal(foldRate(ev, T + 125_100).speed, 0)
})

test('短于 800ms 的样本丢弃', () => {
  const ev = [{ type: 'step/start', time: T }, msg(T + 300, 50, T + 100, [100])]
  assert.equal(foldRate(ev, T + 400).speed, 0)
})

test('纯工具调用步骤也计速', () => {
  const ev = [{
    type: 'step/start', time: T,
    }, {
      type: 'assistant/message', time: T + 2000,
      data: { usage: { outputTokens: 120 }, stream: [{ chunk: { type: 'tool-call-chunks', time0: T + 1800, dt: [100] } }] }
    }]
  assert.equal(Math.round(foldRate(ev, T + 2100).speed), 60)
})

test('没有流式数据不计速', () => {
  const ev = [{ type: 'step/start', time: T }, { type: 'assistant/message', time: T + 2000, data: { usage: { outputTokens: 99 }, stream: [] } }]
  assert.equal(foldRate(ev, T + 2100).speed, 0)
})
