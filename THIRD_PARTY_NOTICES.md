# Third-party attribution

This repository preserves the original DeepSeek Harness MIT license in [LICENSE](LICENSE) and its retained Git history. DeepSeek's copyright and notice must remain with redistributed substantial portions.

**Tern Surface Protocol and `@stencil-hq/tern@0.1.0`** are the work of **Can Bölük / Stencil Labs** and contributors. The Tern SDK is MIT-licensed. The bundled production JavaScript includes the SDK with the qualified, repository-local patch; redistributed builds must preserve its MIT license and notices. Preparation copies the package's own license when present. Because the published 0.1.0 package omits that file, preparation otherwise verifies and copies the exact upstream notice vendored at `third_party/stencil-hq-tern-sdk/LICENSE`; `PROVENANCE` beside it records the source and pinned Git blob. The redistributed notice is `licenses/tern-LICENSE`; this attribution file does not replace it.

**Hermes Agent UI/TSP contributors** provided comparative patterns for semantic surfaces, transcript/tool projection and SDK tests. The standalone DSH bundle consumes DSH's public Agent/Session and Cordis services rather than copying another Agent runtime. See the upstream [DSH RFC #6](https://github.com/kvnloo/deepseek-harness/issues/6) for credited prior art.
