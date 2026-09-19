# Current version and limits

This is an executable first version, not a guarantee of autonomous operation in every application.

- Implemented: local chat, persistent memory, tool loop, project files, terminal, document readers, browser, Windows desktop adapter, model selection, gaming mode and Arabic UI.
- Existing tools can run coding/build/test commands and feed errors back to the model. Complex project quality remains model-dependent; maximum 16 rounds prevents an endless repair loop.
- Process-based gaming detection only recognizes names listed in settings. It cannot recognize every game automatically. Interrupted tasks remain in history and require a follow-up request.
- The agent runs while the local app is open; no scheduled background worker or unattended recurring workflow runner has been added.
- No cloud API keys, subscriptions, external-provider connectors, universal MCP marketplace, embeddings or model fine-tuning are configured.
- Vision can inspect uploaded images or screenshots with a compatible model. Desktop coordinates and actions remain error-prone and must be reviewed before important changes.
- Scanned PDFs do not receive automatic OCR in the document reader. Legacy `.doc` and `.xls` files are not supported; use `.docx` and `.xlsx`.
- No public deployment or external access is configured. GitHub stores source code only.

Model references: [Qwen3 8B](https://ollama.com/library/qwen3:8b), [Qwen3-VL 8B](https://ollama.com/library/qwen3-vl:8b), [Ollama Windows](https://docs.ollama.com/windows).
