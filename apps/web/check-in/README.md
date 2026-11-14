# Check-in UI (SV-008)

This directory exports an independently mountable, semantic check-in form. It intentionally has no shared navigation, auth client, browser persistence, scene renderer or automatic mounting. Shared web files are owned by pending PR #13. The form needs no WebGL and leaves the original NICU ward and all 12 GLBs in use.

After PR #13 coordination, the existing web shell can mount the form in its equipment workspace:

```js
import {mountCheckIn} from './check-in/index.js';
const view = mountCheckIn(container, {
  organizationId: selectedOrganizationId,
  request: authenticatedRequest,
  onCommitted: () => equipmentAdapter.refetch()
});
// Call view.destroy() when changing organization, identity or screen.
```

`authenticatedRequest(path, options)` must use the host's existing authenticated transport, return parsed response JSON, and throw an error with HTTP `status` on failure. It must forward `method`, `headers`, serialized `body` and `signal`, keep credentials in the existing transient auth boundary, and enforce the host's origin/CSRF rules. This module stores no credentials. Do not change an active mounted form's organization or authenticated identity; destroy and remount it so an uncertain request cannot be retried under another context.

Include the existing `src/styles.css` first and this directory's `styles.css` second. The scoped mint surface, ink-on-coral action, rounded controls and wrapping mobile layout use the existing design tokens. The user-selected `design/references/homepage-reference.png` was inspected; this operational form adopts its calm NICU workspace language without copying the unrelated departments or approver portrait.

The host's smallest integration is a container, stylesheet link, import/mount call, existing-transport wrapper and refetch callback. These changes belong in the shared shell/client files after coordination with PR #13; none is included here. Until mounted by that owner, the module is not reachable from the existing app navigation.

## Labels and interactions

- Print the stable equipment external ID (example `EQ-001`) as a barcode/QR value, optionally prefixed `SV1:`. IDs are case-sensitive, at most 64 ASCII identifier characters. No URLs, HTML, patient fields or instructions are accepted or followed.
- Type the ID, or use a keyboard scanner and choose its source. Enter in the ID field moves focus to explicit confirmation; a scan does not submit automatically. Select a location returned by the authenticated server, then confirm.
- Camera scanning starts only when the user presses **Start camera**, in a secure context with supported `BarcodeDetector` and media APIs. The browser retains its permission prompt; this module does not accept it. Denial, unsupported APIs and invalid labels retain manual entry. Stop, successful scan, hidden document, navigation and destruction release tracks. No camera permission prompt was accepted in development.
- A submission captures the user's observation time and a new idempotency key. Retrying an interrupted/cancelled request keeps both, even if the server may have committed. A repeated unchanged scan after success produces no second request. **New check-in** explicitly starts another observation. Changing the final equipment/location/source creates a distinct attempt; an interrupted previous request may still have committed and remains auditable.
- The result displays the server-returned actor/source, observed and received times, actual record provenance, and whether an older observation was retained without changing the current location. Synthetic fixtures remain marked `synthetic-seed`; no live tracking or measured geometry is claimed.

Automated DOM/scanner tests are under `services/api/check-in/tests/web.test.mjs`; they cover label parsing, keyboard Enter handling, accessible labels/errors, duplicate submission, network retry, cancellation, permission denial, explicit camera start, successful QR decoding and pending-camera cancellation. Narrow-screen coverage is CSS/source inspection only. Real browser layout, tab traversal, camera hardware and permission UI remain unverified; no screenshots were saved or uploaded.
