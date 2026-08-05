// Erzeugt das Schlüsselpaar für Web Push.
//
//   node tools/make-vapid.mjs
//
// Einmalig. Der öffentliche Teil geht an den Browser und steht in jedem Abo,
// der geheime bleibt Secret. Ein neues Paar macht alle bestehenden Abos
// ungültig – dann muss jedes Gerät die Benachrichtigungen neu einschalten.

import { vapidSchluesselpaar } from '../src/push.js';

const { oeffentlich, geheim } = await vapidSchluesselpaar();

console.log(`
Für die Produktion:

  npx wrangler secret put VAPID_PUBLIC
  ${oeffentlich}

  npx wrangler secret put VAPID_PRIVATE
  ${geheim}

Für lokale Tests dieselben zwei Zeilen in .dev.vars:

VAPID_PUBLIC=${oeffentlich}
VAPID_PRIVATE=${geheim}
`);
