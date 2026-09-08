// AI SDK 协议兼容性自检：用 SDK 内部解析器验证服务端流格式
import { parseStreamPart } from '@ai-sdk/ui-utils'

const lines = [
  '0:"conv123"',
  'd:{"type":"text-delta","delta":"你好"}',
  'd:{"type":"data-json","data":{"type":"tool_call","name":"quiz_generator","id":"c1"}}',
  'd:{"type":"data-json","data":{"type":"tool_result","name":"quiz_generator","summary":"完成"}}',
  'd:{"type":"data-json","data":{"type":"ask","question":"q?","options":["a","b"]}}',
  'd:{"type":"data-json","data":{"type":"done","message_id":"m1"}}',
  'd:{"type":"finish-message","finishReason":"stop","usage":{"promptTokens":1,"completionTokens":2}}',
  'e:{"type":"error","error":{"message":"boom"}}',
]

let allOk = true
for (const l of lines) {
  try {
    console.log('OK  ', JSON.stringify(parseStreamPart(l)))
  } catch (err) {
    allOk = false
    console.log('FAIL', l, '->', err.message)
  }
}
console.log(allOk ? 'ALL PARTS PARSE OK' : 'SOME PARTS FAILED')
