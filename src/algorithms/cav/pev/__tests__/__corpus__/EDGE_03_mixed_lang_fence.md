## 1. 内容

某些渲染器要求 fence info 含 `json` 才能高亮,模型于是写成了 (pev json) 形式。extractor 必须按词边界识别。

```pev json
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  "observations": [],
  "hypothesis_updates": [
    {
      "op": "create",
      "id": "H1",
      "kind": "anti-analysis",
      "text": "Possible TLS callback anti-debug check.",
      "confidence": 0.4
    }
  ],
  "next_action": { "kind": "observe_only", "rationale": "queue ida-anti-debug-scan" }
}
```

```cav
{ "self_entropy": 0.5, "calibration": null, "update_kl": null, "repair_style": "none" }
```
