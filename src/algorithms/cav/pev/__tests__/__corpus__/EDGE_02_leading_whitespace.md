## 1. 内容

模型在 fenced block 前多打了几个空格(常见于复制粘贴)。extractor 应当容忍。

   ```pev
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  "observations": [],
  "hypothesis_updates": [
    {
      "op": "create",
      "id": "H1",
      "kind": "compiler",
      "text": "Likely MSVC C++ runtime present.",
      "confidence": 0.6
    }
  ],
  "next_action": { "kind": "observe_only", "rationale": "queue dnspy probe" }
}
```

```cav
{ "self_entropy": 0.3, "calibration": null, "update_kl": null, "repair_style": "none" }
```
