## 1. 内容

模型用了 camelCase(JS/TS 风格),应当被 normaliseKeys 转成 snake_case。

```pev
{
  "schemaVersion": "1.0",
  "agentId": "static_analyst",
  "round": 0,
  "observations": [
    { "evidenceId": "E1", "verdict": "confirms", "confidence": 0.9 }
  ],
  "hypothesisUpdates": [
    { "op": "promote", "id": "H1", "rationaleShort": "diec confirmed UPX 4.0" }
  ],
  "nextAction": {
    "kind": "tool_call",
    "hypothesisId": "H1",
    "toolPlanId": "packer::upx-test",
    "argsOverride": null
  }
}
```

```cav
{ "self_entropy": 0.1, "calibration": null, "update_kl": null, "repair_style": "none" }
```
