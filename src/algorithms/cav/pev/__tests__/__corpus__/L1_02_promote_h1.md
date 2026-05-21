## 1. 内容

`packer::diec` 在 round 0 触发,stdout 含 "UPX(4.0)[NRV,brute]"。匹配 confirms 正则。
将 H1 从 open 升级到 evidence,信心拉到 0.95。

```pev
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  "observations": [
    { "evidence_id": "E1", "verdict": "confirms", "confidence": 0.95 }
  ],
  "hypothesis_updates": [
    { "op": "promote", "id": "H1", "rationale_short": "diec confirmed UPX 4.0 packer" }
  ],
  "next_action": {
    "kind": "observe_only",
    "rationale": "let dynamic agent take next slot"
  }
}
```

```cav
{ "self_entropy": 0.1, "calibration": 0.85, "update_kl": 0.4, "repair_style": "none" }
```
