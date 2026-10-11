# Audyt GitHub Issues — 2026-10-10

Źródło: GitHub `re-invertion/resourcePortal`, 32 otwarte zgłoszenia. Punkt odniesienia kodu: `main@3002821dd4cf3f493de25d26b55ad7661c9f0770`.

> **Stan:** wstępny audyt statyczny. Wykrycie źródła w opisie issue **nie oznacza** reprodukcji ani naprawy. Dla każdego issue konieczny jest test: przed zmianą błąd odtwarzalny, po zmianie test przechodzi. Zamknięcie możliwe wyłącznie po weryfikacji wdrożonej/zmianie dostarczonej do oficjalnej wersji.

| Issue | Opis | Wskazany obszar | Stan |
|---|---|---|---|
| [#204](https://github.com/re-invertion/resourcePortal/issues/204) | [Security][HIGH] Custom domains can be published without ownership verification | `packages/resourceportal-api/src/domains/domains.service.ts` | Do odtworzenia i naprawienia |
| [#207](https://github.com/re-invertion/resourcePortal/issues/207) | [Security][MEDIUM] Registry validation can perform server-side requests to internal addresses | `packages/resourceportal-api/src/registries/registries.service.ts` | Do odtworzenia i naprawienia |
| [#208](https://github.com/re-invertion/resourcePortal/issues/208) | [Security][HIGH] Egress guard clears active firewall rules before rebuilding them (fail-open window) | `packages/resourceportal-api/src/network-egress/egress-guard.runner.ts` | Do odtworzenia i naprawienia |
| [#210](https://github.com/re-invertion/resourcePortal/issues/210) | [Security][HIGH] RP Gate and Device VPN clear forwarding deny rules every reconciliation | `packages/resourceportal-api/src/networking/device-vpn-runtime.runner.ts` | Do odtworzenia i naprawienia |
| [#213](https://github.com/re-invertion/resourcePortal/issues/213) | [Reliability][MEDIUM] MCP dynamic client registration can hang indefinitely on ZITADEL requests | `packages/resourceportal-api/src/mcp/mcp-oauth-dcr.service.ts` | Do odtworzenia i naprawienia |
| [#215](https://github.com/re-invertion/resourcePortal/issues/215) | [Reliability][MEDIUM] Interactive OIDC login and session refresh rely on requests without timeouts | `packages/resourceportal-api/src/auth/auth-flow.service.ts` | Do odtworzenia i naprawienia |
| [#217](https://github.com/re-invertion/resourcePortal/issues/217) | [Security][HIGH] Egress guard stops refreshing workload rules while policy snapshot is missing | `packages/resourceportal-api/src/network-egress/egress-guard.runner.ts` | Do odtworzenia i naprawienia |
| [#218](https://github.com/re-invertion/resourcePortal/issues/218) | [Security][HIGH] Tenant Docker registry credentials persist in shared worker and can be reused across deployments | `packages/resourceportal-api/src/internal/stack-registry-auth.service.ts` | Do odtworzenia i naprawienia |
| [#221](https://github.com/re-invertion/resourcePortal/issues/221) | [Security][HIGH] Provisioned tenant volumes are made world-writable (0777) on the storage host | `packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.ts` | Do odtworzenia i naprawienia |
| [#222](https://github.com/re-invertion/resourcePortal/issues/222) | [Auth][MEDIUM] Concurrent expired-session requests can race refresh-token rotation and revoke valid session | `packages/resourceportal-api/src/auth/auth-session.service.ts` | Do odtworzenia i naprawienia |
| [#227](https://github.com/re-invertion/resourcePortal/issues/227) | [Security][HIGH] Platform updater accepts manifests from arbitrary GitHub repositories without release authenticity verification | `packages/resourceportal-api/src/operations/executors/platform-release-update-operation.executor.ts` | Do odtworzenia i naprawienia |
| [#228](https://github.com/re-invertion/resourcePortal/issues/228) | [Storage][HIGH] NFS readiness probe can pass on local writable directories without shared storage | `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.ts` | Do odtworzenia i naprawienia |
| [#238](https://github.com/re-invertion/resourcePortal/issues/238) | [Security][HIGH] Tenant-specific IdP requirement is bypassed by logging in without tenant context | `packages/resourceportal-api/src/auth/auth-flow.service.ts` | Do odtworzenia i naprawienia |
| [#242](https://github.com/re-invertion/resourcePortal/issues/242) | [Upgrade][HIGH] 0.2.68 → 0.2.70 fails after PostgreSQL rollout: mktemp: : Invalid argument | `scripts/installer/upgrade.sh` | Do odtworzenia i naprawienia |
| [#252](https://github.com/re-invertion/resourcePortal/issues/252) | [Security][HIGH] CPU=0 creates unlimited tenant workloads while quota, capacity and billing count zero CPU | `packages/resourceportal-api/src/app-groups/dto/create-single-app.dto.ts` | Do odtworzenia i naprawienia |
| [#253](https://github.com/re-invertion/resourcePortal/issues/253) | [Security][HIGH] Concurrent AppGroup manifest imports bypass tenant resource quotas | `packages/resourceportal-api/src/app-groups/app-group-manifest.service.ts` | Do odtworzenia i naprawienia |
| [#254](https://github.com/re-invertion/resourcePortal/issues/254) | [Storage][HIGH] Detaching a volume in an undeployed draft permits deletion of live application data | `packages/resourceportal-api/src/app-groups/app-groups.service.ts` | Do odtworzenia i naprawienia |
| [#255](https://github.com/re-invertion/resourcePortal/issues/255) | [Billing][MEDIUM] Volume create and resize bypass price-list preflight due to missing /api prefix | `packages/resourceportal-api/src/main.ts` | Do odtworzenia i naprawienia |
| [#256](https://github.com/re-invertion/resourcePortal/issues/256) | [Security][MEDIUM] CLI sends stored credentials to a different --api-url without origin binding | `packages/resourceportal-cli/src/auth.ts` | Do odtworzenia i naprawienia |
| [#257](https://github.com/re-invertion/resourcePortal/issues/257) | [Billing][HIGH] Undeployed draft replica/resource edits can stop billing while the old workload continues running | `packages/resourceportal-api/src/app-groups/stage11-app-groups.service.ts` | Do odtworzenia i naprawienia |
| [#258](https://github.com/re-invertion/resourcePortal/issues/258) | [Functional][MEDIUM] Volumes UI reports completion for queued operations and never observes their final result | `packages/resourceportal-api/src/volumes/volumes.controller.ts` | Do odtworzenia i naprawienia |
| [#259](https://github.com/re-invertion/resourcePortal/issues/259) | [Functional][MEDIUM] CLI coerces textual variable/config/secret values into numbers and booleans, causing valid input to fail | `packages/resourceportal-cli/src/index.ts` | Do odtworzenia i naprawienia |
| [#260](https://github.com/re-invertion/resourcePortal/issues/260) | [Functional][MEDIUM] Older useApi requests can overwrite refreshed resource data after a mutation | `packages/resourceportal-web/src/hooks/use-api.ts` | Do odtworzenia i naprawienia |
| [#261](https://github.com/re-invertion/resourcePortal/issues/261) | [Functional][MEDIUM] Machine credentials UI hides rotation persistence failures and always displays success | `packages/resourceportal-api/src/service-identities/service-identity-credentials.service.ts` | Do odtworzenia i naprawienia |
| [#263](https://github.com/re-invertion/resourcePortal/issues/263) | [Functional][MEDIUM] Removing or renaming an environment variable in the application editor preserves the old key | `packages/resourceportal-web/src/pages/app-group/app-edit.tsx` | Do odtworzenia i naprawienia |
| [#264](https://github.com/re-invertion/resourcePortal/issues/264) | [Functional][MEDIUM] Application editor cannot clear existing optional string settings because blank values are omitted | `packages/resourceportal-web/src/pages/app-group/app-edit.tsx` | Do odtworzenia i naprawienia |
| [#265](https://github.com/re-invertion/resourcePortal/issues/265) | [Reliability][HIGH] Disaster recovery reports healthy even when storage validation returns Error | `packages/resourceportal-api/src/disaster-recovery/disaster-recovery.service.ts` | Do odtworzenia i naprawienia |
| [#266](https://github.com/re-invertion/resourcePortal/issues/266) | [Reliability][HIGH] Replaying VOLUME_CREATE after a committed side effect fails with a name conflict instead of recovering the result | `packages/resourceportal-api/src/operations/executors/volume-operation.executors.ts` | Do odtworzenia i naprawienia |
| [#267](https://github.com/re-invertion/resourcePortal/issues/267) | [Reliability][HIGH] Runtime restore reapplies old deployment replicas without honoring later stop or runtime blockers | `packages/resourceportal-api/src/disaster-recovery/runtime-restore.service.ts` | Do odtworzenia i naprawienia |
| [#268](https://github.com/re-invertion/resourcePortal/issues/268) | [Reliability][MEDIUM] Disaster recovery checks drift for at most 500 groups despite requesting a 10,000-group batch | `packages/resourceportal-api/src/disaster-recovery/disaster-recovery.service.ts` | Do odtworzenia i naprawienia |
| [#269](https://github.com/re-invertion/resourcePortal/issues/269) | [Functional][MEDIUM] Tenant billing still offers Save quota but calls a removed tenant mutation endpoint (404) | `packages/resourceportal-web/src/pages/tenant-resources.tsx` | Do odtworzenia i naprawienia |
| [#270](https://github.com/re-invertion/resourcePortal/issues/270) | [Functional][MEDIUM] Stable oldest volumes can permanently starve usage measurement of later volumes | `packages/resourceportal-api/src/volumes/volume-usage-reconciler.service.ts` | Do odtworzenia i naprawienia |

## Zasada przejścia do `resolved`

1. Potwierdzony test regresyjny przed/po zmianie lub dowód, że wadliwy kod nie występuje w `main`.
2. Wymagane specyficzne testy bezpieczeństwa i środowiskowe (Swarm, VPN, storage) tam, gdzie jest to niezbędne.
3. Zatwierdzony PR przez Merge Queue, CI zielone, automatyczny release zweryfikowany.
4. Komentarz w issue z przyczyną, SHA, testem i zakresem weryfikacji. Nie zamykać przy częściowym fixie.

## Implementacja w izolowanym worktree (jeszcze nie wydana)

| Issue | Zmiana lokalna | Weryfikacja jednostkowa | Status GH |
|---|---|---|---|
| #207 | Ograniczenie SSRF przy weryfikacji registry; weryfikacja IP z DNS, zakaz adresów lokalnych i zarezerwowanych, pinning IP na socket, bez redirectów | `registry-ping.spec.ts` i `registries.service.spec.ts` | OPEN – brak PR/release oraz integracyjnej walidacji |
| #252 | Minimum CPU 0.01 w DTO i manifestach, niezależna walidacja w workerze | `cpu-quota-validation.spec.ts`, `app-group-manifest.spec.ts`, `deployment-cpu-validation.spec.ts` | OPEN – brak PR/release |
| #253 | Advisory tenant quota lock i powtórny quota check w transakcji importu | `app-group-manifest.service.spec.ts` (test pozorowanego wyścigu) | OPEN – test w prawdziwej bazie PostgreSQL jeszcze wymagany |
| #256 | Blokada użycia zapisanych CLI credentials wobec innego API URL przed refresh | `packages/resourceportal-cli/test/auth.test.js` | OPEN – brak PR/release |

Nie oznaczać tych zgłoszeń jako rozwiązane, dopóki brak oficjalnego merge, release i wymaganego dowodu działania. Pozostałe issue nadal otwarte.

| #204 | Wymóg zweryfikowanego tenantowego custom root przy rejestracji/zmianie, kontrola własności na aktualnym rekordzie przy deploy i reconciliacji Traefik; odrzucenie historycznych DNS-only hostnames | `domains.service.spec.ts`, `domain-publication.spec.ts`, `deployment-domain-ownership.spec.ts`, `ingress-reconciler.service.spec.ts` | OPEN – potrzeba testu na Swarm i wydania; historyczne niezweryfikowane domeny utracą publiczny routing |

### Ryzyko kompatybilności domen

Dawna rejestracja bez weryfikowanego root domain była podatna na przejęcia. Nowa walidacja celowo odmawia publikacji takich rekordów. Administrator powinien przed aktualizacją zweryfikować istniejące manual custom roots (TXT lub autoryzowany Cloudflare OAuth) i przetestować ingress na środowisku preprodukcyjnym. Nie oznaczać #204 za naprawiony tylko na podstawie testów jednostkowych.

## Kolejne lokalne poprawki — 2026-10-11

| Issue | Lokalnie poprawione zachowanie | Testy | Czy można zamknąć? |
|---|---|---|---|
| #218 | Każdy docker login i docker stack deploy korzysta z odrębnego DOCKER_CONFIG, usuwanego także po błędzie. Named Docker context kopiowany bez globalnego config.json. Dotyczy również rollback. | stack-registry-auth, stack-apply, deployment-registry-isolation, isolated-docker-context | NIE: wymagany test równoległych wdrożeń na realnym Swarm |
| #254 | Przed usuwaniem wolumenu: tenant lock, kontrola bieżących i aktywnych snapshotów, zbieżności runtime; attach współdzieli lock i sprawdza status Ready. | deployed-volume-reference, stage7-volume-lifecycle, volume-attachment-race | NIE: wymagany test w prawdziwym Swarm ze znacznikiem danych i udanym unmount |

Nie przenosić issue do resolved bez dowodu naprawy w wydanej wersji.

| #210 | Dla Device VPN i Site/Gate VPN powtarzana reconciliacja bez zmian nie zapisuje ponownie iptables-restore; nieudana atomowa próba zachowuje poprzednią zapamiętaną rewizję i jest ponawiana. | vpn-firewall-revision.spec.ts, device-vpn-runtime.logic.spec.ts, gate-runtime.logic.spec.ts | NIE: wymagany fail-closed test prawdziwego ruchu na VPN podczas restartów i błędów restore |

| #221 | Local filesystem adapter izoluje root-owned katalogi tenantów (mode 0700), blokuje symlink tenant/volume, egzekwuje to podczas nowego provision i przy pomiarze/resize istniejących wolumenów. Bezpośrednio bind-mounted katalog pozwala wciąż na dowolny UID aplikacji. | local-filesystem-storage-adapter.service.spec.ts (XFS i ext4, 17/17) | OPEN – potrzebne host-UID E2E i pełna migracja starych katalogów |

## Etap 2026-10-11 — niezacommitowane poprawki i wyniki testów

Poniższe pozycje są wykonane wyłącznie lokalnie; żadne issue nie powinno zostać zamknięte bez merge, release i właściwych testów.

| Issue | Lokalnie poprawione zachowanie | Testy i pozostałe ryzyko |
|---|---|---|
| #213 | Deadline, timeout i limit rozmiaru DCR response | 5/5; potrzeba ZITADEL E2E |
| #222 | PostgreSQL advisory transaction lock i CAS revoke sesji | 9/9; wymagane realne IdP i PostgreSQL |
| #238 | Podpisany provider provenance w sesji i wymaganie go na tenant API | 39/39 auth/OIDC; potrzebny rzeczywisty signed claim ZITADEL i E2E |
| #255 | Billing preflight z prefiksem /api | 9/9 |
| #257 | Billing CPU/RAM/replicas ze snapshotu wdrożonego, nie draftu | 3/3; historyczne snapshoty i E2E |
| #258 | UI czeka na wynik worker Operations dla volume create/resize/delete | 14/14 storage UI |
| #259 | CLI zachowuje surowe wartości pól tekstowych | 2/2 testy coercion |
| #260 | useApi ignoruje stare odpowiedzi po refresh i zmianie ścieżki | 3/3 |
| #261 | UI ujawnia nieudaną persistence/audit po rotate credentials | 2/2; ZITADEL E2E |
| #263, #264 | Explicit null dla usuniętych env i pustych optional fields | 3/3 app-edit |
| #265 | DR respektuje storage backend status Error | regresja DR |
| #266 | Durable volume ID oparty o operation ID i resume po crash, ochrona mismatch | 11/11; E2E crash boundary |
| #267 | DR restore respektuje aktualne stop/pending delete/tenant/billing/maintenance | regresja DR; wymagany Swarm |
| #268 | Pełna reconciliacja drift, nie 500-group cap | regresja DR; E2E ponad 500 grup |
| #269 | Quota tenant read-only, bez usuniętego PATCH | 7/7 billing UI |
| #270 | Cursor sweep wolumenów bez starvation | regresja usage; restart worker E2E |
| #228 | NFS mount-type i widoczność shared nonce we wszystkich eligible nodes, zakaz disable przy multi-node, diagnostyka node | 8/8; nie wykonano realnego NFS failover ani cleanup probe artifacts |
| #242 | Preflight sprawdza /tmp i stanowy katalog checkpointów przed quiesce | installer release test green; wymaga testu legacy upgrade 0.2.68 |
| #227 | Na base main istnieje canonical GitHub URL i image repo allowlist; uzupełniono testy negatywne | 8/8 executor + installer; signed attestation nadal niezaimplementowana |

Nie zamykać #227, #228, #238 i #242 bez dodatkowych dowodów. Wyłącznie wykonane testy jednostkowe/regresyjne nie dowodzą działania na rzeczywistym Swarm, ZITADEL lub podczas upgrade.


### Uzupełniająca weryfikacja 2026-10-11 (po naprawie regresji)

- #215: refresh przy przejściowym 503, błędzie discovery lub timeout nie odwołuje sesji i nie usuwa browser cookie; jawny OAuth invalid_grant nadal kończy ją jako 401. Nowe regresje OIDC i auth controller zielone (44/44 wybrane; następnie 24/24 z nową regresją discovery).
- #238: token bez podpisanej informacji o rzeczywiście użytym tenant IdP nie może być autoryzowany tylko na podstawie wybranego IdP w cookie/request; token z poprawnie podpisanym zgodnym dostawcą jest dopuszczony. 16/16 OIDC testów.
- #228: zachowanie single-node w obu walidatorach jest zgodne: jawnie wyłączone sprawdzanie NFS przy jednym eligible node dopuszcza wyłącznie test write/read, przy więcej niż jednym node odmowa. 12/12 testów obu serwisów. Wymaga nadal realnego cross-node mount testu oraz rozwiązania usuwania znaczników.
- #227: regression 8/8 platform release executor, negatywne manifest image provenance i installer release tests PASS. Brak kryptograficznego podpisu/attestation weryfikowanego w runtime; nadal OPEN.
- npm API build, Web build, CLI build, lint API/Web/CLI, 167 + 131 testów API, 29 UI, 36 CLI, 22 fastfix taxonomy, Prisma schema validate oraz installer release/NFS/storage shell suites przeszły lokalnie (poszczególne przebiegi; nie jest to jeden pełny CI run).
- Workspace nadal bez commit, merge, release ani deploy. Wszystkie 32 issue GH nadal OPEN. Nie deklarować końca bez weryfikacji na prawdziwym Swarm/ZITADEL i oficjalnego PR/release.

### Etap 2026-10-11: podpisana atestacja i nowe regresje (nieopublikowane)

- #227: workflow Release podpisuje manifest poprzez GitHub Actions OIDC `actions/attest@v4` i sprawdza go CLI; privileged updater sprawdza właściwy byte-digest, oficjalną tożsamość signera, repo oraz source-ref main zanim wykona upgrade preflight. API runtime image doinstalowuje github-cli. Wykryta brakująca/podmieniona atestacja blokuje upgrade. Installer release tests PASS. **Wciąż potrzebny test naprawdę podpisanego manifestu wygenerowanego w GitHub Actions CI oraz build runtime image**.
- #228: marker protocol ma barierę ACK i cleanup po potwierdzeniu wszystkich node; 15/15 testów unitowych NFS. Bez dostępu do rzeczywistego Swarm nie testowano NFS failover. Cross-node E2E pozostaje wymagany.
- #268: nowa regresja sprawdzająca pełne 501 grup, keyset pagination i brak duplikatów. PASS.
- #213, #215, #222: pełny zestaw auth/MCP/update executor 122/122 testów; installer release oraz Zitadel management shell tests PASS. **Nie przeprowadzono realistycznego testu konkurencyjnych sesji z działającym ZITADEL i PostgreSQL**.
- #242: lokalny upgrade preflight sprawdza czy można utworzyć pliki zarówno w /tmp jak i w katalogu checkpointów, i blokuje zmianę usług przy błędzie. Testy offline PASS. **Nie przeprowadzono realnego upgrade z 0.2.68** — nie zamykać issue przed potwierdzonym testem w infrastrukturze.
- Lokalny Workspace v2 nie udostępnia ani polecenia docker, ani ssh, ani psql. E2E na dedykowanym hoście nie można uruchomić tym narzędziem; należy zapewnić CI/Swarm runner i przeprowadzić destrukcyjne testy wyłącznie w dedykowanym środowisku.

## Finalizacja lokalnej implementacji 2026-10-11 — audyt publikacji

**Zestaw bazowy:** 32 GH issues. Wszystkie objęto zmianami albo weryfikacją w lokalnym worktree; brak podstaw do zamykania na GitHubie przed publikacją i testami infrastrukturalnymi.

**Sprawdzone wyniki:** API 865/865 (202 test files, pełny ponowiony przebieg, exit 0), Web 306/306, CLI 36/36, pełne lint + build, schema Prisma validate, pełne installer shell, CLI release package, test katalogu i fastfix 49/49, test/installer/test-releases.sh, git diff --check. Pierwszy przebieg API 864/865 zakończył się błędem whitelisty raw SQL; dopisano i ponowiono cały API 865/865 PASS.

### Matryca napraw — lokalny test a bramka środowiskowa

| Nr | Lokalny dowód/test | Wymagana weryfikacja po publikacji |
|---|---|---|
| #204 | domains.service + domain-publication + deployment-domain-ownership + ingress-reconciler | prawdziwe DNS/TXT i ingress na Swarm; migracja historycznych domen |
| #207 | registry-ping.spec, registries.service.spec | serwer HTTP/DNS rebinding i negative SSRF E2E |
| #208 | egress-guard.logic.spec, instalacja atomowych rulesets | live packet flow przy reinstalacji iptables |
| #210 | vpn-firewall-revision.spec, device-vpn/gate runtime | real device/site VPN; restart i fail-close |
| #213 | mcp-oauth-dcr.service.spec | ZITADEL DCR HTTP timeout/failure |
| #215 | auth-flow, auth-session, auth.controller, oidc-auth specs | IdP outage i refresh sesji rzeczywistej |
| #217 | egress-guard.logic.spec + runner preserve snapshot | nowa maszyna/workload przy utracie polityki, iptables |
| #218 | stack-registry-auth, stack-apply, isolated-docker-context | dwa równoległe deploye z różnymi registry secrets |
| #221 | local-filesystem-storage-adapter.spec | uid/gid/mode realnych kontenerów i istniejące wolumeny |
| #222 | auth-session.service.spec, advisory lock + singleflight | równoległe sesje na 2 API replicas z PostgreSQL |
| #227 | platform-release-update executor, test installer attestation negatywny, YAML tests | GitHub runner podpisuje i rzeczywisty updater weryfikuje attestację |
| #228 | shared-nfs-probe, nfs-validator, stack-volume-provisioner specs | prawdziwy NFS 2+ node + cleanup + failover |
| #238 | tenant-idp-enforcement, oidc-auth.service specs | podpisany claim IdP wydawany przez konfigurację ZITADEL |
| #242 | installer release tests BusyBox mktemp, recovery script source checks | upgrade z 0.2.68 i nieudany upgrade/recovery na dedykowanej VM |
| #252 | cpu-quota-validation, deployment-cpu-validation, app manifest | workload zero-CPU odrzucony przez API/worker |
| #253 | app-group-manifest.service.spec, tenant advisory lock | równoczesne importy przy granicznej kwocie w PostgreSQL |
| #254 | volume-attachment-race, deployed-volume-reference, stage7 volume | volume live mount, draft detach, delete i data-integrity |
| #255 | billing-preflight.guard.spec | API /api/tenants/.../volumes create/resize |
| #256 | CLI auth.test, origin binding | autentyczny CLI bearer i zmieniony --api-url |
| #257 | deployed-compute-allocation, billing worker tests | draft vs deployed replica billing w działającym Swarm |
| #258 | volume-operation-tracker.test oraz UI | rzeczywista kolejka worker: pending → success/failure |
| #259 | flag-coercion.test, CLI auth tests | CLI tekstowe sekrety/env 'true'/'001' |
| #260 | use-api.test | sieciowa zmiana route i przeplot odpowiedzi HTTP |
| #261 | machine-credential-rotation.test | błąd persistence ZITADEL / audit i UI visibility |
| #263 | app-edit.test, jawne null w PATCH | zmiana/renaming env i sprawdzenie odczytu z API |
| #264 | app-edit.test, optional blank fields | czyszczenie settings i odczyt z API |
| #265 | disaster-recovery.service.spec | failed storage backend w flow DR |
| #266 | volume-operation.executors + stage7-volume-lifecycle | crash/reclaim workera po side effect i trwałość danych |
| #267 | runtime-restore-policy.spec + runtime-restore.service.spec | Swarm stop/pending delete i restore |
| #268 | runtime-drift-reconciler.pagination.spec + DR service spec | >500 deployed groups i pełny scan |
| #269 | tenant-resources.test, billing-funding-ui.test | API nie ma quota PATCH, UI odczyt tylko |
| #270 | volume-usage-reconciler.service.spec | restart workera i keyset fairness na prawdziwym storage |

**Status po lokalnej walidacji:** implementacje gotowe do review, nie „resolved on GitHub”. Nie wykonano realnych E2E (Workspace nie ma Docker/SSH) oraz nie ma jeszcze merge, release i deploy. Konieczne realne E2E/CI oraz review PR; zamknąć tylko zgłoszenia zweryfikowane po wydaniu. Pozostałe pozostawić otwarte z dowodem blokera. Wszystkie wyniki lokalne nie stanowią dowodu skuteczności wdrożenia.

### Finalna kontrola lokalna — 2026-10-11

- Wszystkie 32 otwarte GitHub issues figurują w tym audycie. W ramach izolowanego worktree wprowadzono poprawki i testy regresyjne dla zgłoszeń; nie należy utożsamiać pozytywnego testu lokalnego z produkcyjną weryfikacją.
- `npm run lint && npm run build && git diff --check`: **PASS** dla repo (API, CLI, Web/SSR).
- `npm --workspace @resource-portal/api test` uruchomiony ponownie po dopuszczeniu parametryzowanego advisory lock do raw-sql-policy: **865/865**, 202 zestawy.
- `npm run test` (pierwszy pełny przebieg) wykazał 1 brak wpisu w jawnym raw-SQL allowlist; poprawiono, celowany test polityki przeszedł, drugi pełny test API zakończył się zielono.
- Pełny Web test: **306/306**. CLI: **36/36**. Testy pakietowania release CLI, katalogu testów (**309 plików, 0 unclassified**), 49 testów katalogu i kontraktów release instalatora: **PASS**.
- Nie wykonano testów integracyjnych na działającym multi-node Docker Swarm/NFS, GitHub OIDC attestation w opublikowanym release, aktywnym ZITADEL/IdP i historycznej ścieżce instalacyjnej z v0.2.68. Te testy są obowiązkowe przed uznaniem odpowiednich bugów za resolved i bezpiecznym produkcyjnym rolloutem.
- Workspace GitHub push jest administracyjnie wyłączony. Oficjalne skierowanie zmian do PR/merge queue wymaga zatwierdzenia publikacji i udostępnienia dozwolonej ścieżki push, bez omijania policy.
- Do momentu merge do main, ukończonego release, testu wymaganych kompatybilności/operacji i potwierdzenia napraw nie zamykać GitHub issue. Stan GitHub nadal 32 OPEN.
