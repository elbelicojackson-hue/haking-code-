## 1. 内容

模型用了 Python 风格的 single quote。

```pev
{
  'schema_version': '1.0',
  'agent_id': 'static_analyst',
  'round': 0,
  'observations': [],
  'hypothesis_updates': [
    {
      'op': 'create',
      'id': 'H1',
      'kind': 'compiler',
      'text': 'Likely Go binary based on .gopclntab section name.',
      'confidence': 0.65
    }
  ],
  'next_action': {
    'kind': 'observe_only',
    'rationale': 'plan compiler::go-probe in next round'
  }
}
```

```cav
{ "self_entropy": 0.3, "calibration": null, "update_kl": null, "repair_style": "none" }
```
