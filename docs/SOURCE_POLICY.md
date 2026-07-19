# Source and Access Policy

DesignSignal collects only public metadata, RSS/Atom, bounded public pages, allowlisted images, and verified open-access PDFs. It never attempts login, CAPTCHA solving, paywall bypass, session reuse, access-control evasion, or scraping of private WeChat/Zhihu content. Optional RSSHub URLs must expose public feeds and remain subject to the same host, DNS, timeout, retry, MIME, and byte controls.

Default coverage includes Tsinghua, Zhejiang, Tongji, international HCI labs, OpenAlex and arXiv; Core77, Dezeen, Designboom, Yanko Design, Awwwards and Product Hunt; and OpenAI, DeepMind, Microsoft Research and Hugging Face. A source failure is recorded as degraded. It never triggers a fabricated filler.

Every cached object records URL, retrieval time, MIME, byte count, SHA-256, author, institution, access status, and license status. PDFs require an explicit OA signal; unknown-license PDFs remain links. Publisher images are remote references unless access and license permit caching. Collection rejects non-HTTP(S) URLs, credential-bearing URLs, hosts outside the allowlist, private/link-local/reserved DNS results, unsafe redirects, oversized bodies, and excess feed/API rows.

Credibility is evaluated from provenance and evidence, not brand alone. Reports preserve primary links, distinguish claims from methods, state limitations, and retain all rejected/degraded audit records. The 60-day dedupe uses stable item IDs and canonical URLs.
