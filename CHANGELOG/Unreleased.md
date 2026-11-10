## Unreleased

### Fixes

- Prompt caching: preserve system prompt separators around Anthropic and OpenAI-compatible cache checkpoints so per-turn context keeps its intended text. (#196502)
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
