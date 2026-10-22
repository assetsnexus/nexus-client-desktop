# Nexus Open Use License v1.0

**Copyright © AssetsNexus.org and OmniBot.ai Systems. All rights reserved.**

This license applies to the Nexus Desktop client and the Nexus client libraries in
this repository (the "Software"), unless a file states otherwise.

---

## 1. Preamble

The Software is published to be **used, edited, and self-hosted freely**. You may
build your own clients, integrate the Software with
**[AssetsNexus.org](https://assetsnexus.org)** or **OmniBot.ai Systems**, and run
it on your own infrastructure — including **fully self-hosted deployments** — with
no royalty and no requirement to publish your changes.

The only things this license does not grant are the AssetsNexus and OmniBot brand
rights (see §4) and any warranty (see §6).

## 2. Definitions

- **"Software"** — the source code, binaries, assets, and documentation in this
  repository, including the Nexus Desktop app, the `nexus` CLI, and the `@nexus/*`
  packages.
- **"You"** — the individual or legal entity exercising rights under this license.
- **"AssetsNexus.org"** / **"OmniBot.ai Systems"** — the hosted platform services
  operated under those names (including their sandbox environments).
- **"Custom Client"** — a client application that You build, modify, or distribute
  which incorporates the Software and connects to AssetsNexus.org, OmniBot.ai
  Systems, or a self-hosted Nexus region node.
- **"Self-Hosted Deployment"** — a deployment of the Software, or of other Nexus
  stack components, running on infrastructure You control.

## 3. Grant of rights

Subject to §4 and §5, You are granted a worldwide, royalty-free, non-exclusive
license to:

1. **Use** the Software for any purpose, personal or commercial.
2. **Copy** and **redistribute** the Software, in source or binary form.
3. **Modify** the Software freely for Your own use, including private forks.
4. **Build Custom Clients** on top of the Software and connect them to
   AssetsNexus.org, OmniBot.ai Systems, or a Self-Hosted Deployment.
5. **Self-host** the Software, in whole or in part, with no obligation to disclose
   your modifications, configurations, or infrastructure.
6. **Distribute** modified versions, provided You comply with §4.

**No copyleft.** You are not required to publish Your changes, and You may license
Your own additions and Custom Client code however You choose.

## 4. Conditions

1. **Notices.** Any redistribution of the Software or a derivative work must retain
   this license file and the copyright notice in §1, and must mark modified files
   as modified.
2. **No endorsement or impersonation.** You may not represent Your Custom Client,
   fork, or Self-Hosted Deployment as an official AssetsNexus or OmniBot product or
   service, nor state or imply that AssetsNexus.org or OmniBot.ai Systems endorses
   it, without prior written permission.
3. **Trademarks.** The names "AssetsNexus", "OmniBot", "Nexus", "Nexus Agents",
   their logos, and their branding are **not** licensed here. This license grants no
   trademark rights. Fair, factual references (for example, "connects to
   AssetsNexus.org") are permitted.
4. **Access is not licensed.** This license does not grant any right to access the
   AssetsNexus.org or OmniBot.ai Systems hosted services, APIs, or data. Those are
   governed separately by their own terms of service, and Your account and usage
   remain subject to them.
5. **No circumvention.** You may not use the Software to bypass, disable, or defeat
   authentication, authorization, two-factor, rate-limiting, billing, or other
   access controls of any service You are not authorized to access.
6. **Compliance.** You are responsible for complying with the laws and regulations
   that apply to You, including those covering data protection, export, and
   AI usage.

## 5. Sandbox Preview status

The **Nexus Sandbox Preview** is an early-access build provided for evaluation and
development. It is **not** production software: interfaces, data, and behavior may
change without notice, and issues are expected. Sandbox subscription plans and
usage-based costs are **real charges** where the sandbox environment states so.

You must not rely on the Sandbox Preview for production, safety-critical, or
irreversible operations.

## 6. Third-party components

The Software depends on and bundles third-party open-source components (including
Electron, React, and Three.js) and links against the Nexus client libraries. Those
components remain under their own licenses, which take precedence over this
license for those components. The `native/` directory additionally declares
Apache-2.0 for its Rust crates. See the respective package manifests and any
bundled `LICENSES` files.

## 7. No warranty

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.** You use the Software at
Your own risk, as-is, without warranty.

## 8. Limitation of liability

**IN NO EVENT SHALL THE AUTHORS, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR
ANY CLAIM, DAMAGES, OR OTHER LIABILITY — WHETHER IN AN ACTION OF CONTRACT, TORT, OR
OTHERWISE — ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE**, including lost data, lost profits, service
interruption, or costs incurred through the use of a hosted or self-hosted
deployment.

## 9. Termination

This license terminates automatically if You breach §4 or §5. On termination You
must stop distributing the Software, though Your obligations under §7 and §8
survive. Rights already granted to downstream recipients of a compliant
redistribution are not affected.

## 10. Miscellaneous

- This is a license of rights, not legal advice. If You need certainty for a
  commercial deployment, consult Your own counsel.
- If any provision is held unenforceable, the remainder stays in effect.
- This license is the entire agreement regarding the Software and supersedes prior
  discussions on the same subject.

---

*Questions about commercial use, branding, or a custom arrangement:
**desktop@assetsnexus.org***
