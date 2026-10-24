/**
 * Every word the host shell shows, in English, in one table, so translating the desktop app later is a
 * one-file job (the Android host's catalog, apps/app/src/lib/i18n/en.ts, is where most of this started;
 * phone wording is changed to "computer" here). `{name}` placeholders are filled by {@link t}.
 *
 * House rules: no em-dashes anywhere, British spelling ("colour", "recognised"), plain words.
 */
export const en = {
  // Shell
  "app.name": "LOAM",
  "tabs.label": "Screens",
  "tabs.network": "Network",
  "tabs.people": "People",
  "tabs.activity": "Activity",
  "tabs.settings": "Settings",
  "common.cancel": "Cancel",
  "common.back": "Back",
  "common.close": "Close",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.save": "Save",
  "common.saved": "Saved",
  "common.details": "Details",

  // Hold to confirm
  "hold.holding": "Keep holding…",
  "hold.confirm": "Confirm",

  // Setup
  "setup.welcomeTitle": "Welcome to LOAM",
  "setup.welcomeBody":
    "LOAM turns this computer into a small private network. People nearby join by scanning a code: no internet, no accounts.",
  "setup.nameLabel": "Name your network",
  "setup.nameHint": "People see this name when they join. Leave it blank to use LOAM.",
  "setup.nameTooLong": "Use {max} characters or fewer.",
  "setup.typeTitle": "What kind of network?",
  "setup.typeBody": "This decides who can join, what people can see about each other, and how long anything is kept.",
  "setup.privateTitle": "Private and short-lived",
  "setup.privateBody":
    "Everyone gets a random name and picture, messages disappear after an hour, and you approve each person who joins. Messages are locked with a key that exists only while LOAM runs; pictures and files are deleted the next time it starts.",
  "setup.privateNote": "If LOAM closes or the computer restarts, the network and its messages are gone for good.",
  "setup.communityTitle": "Community",
  "setup.communityBody":
    "People can choose a name and photo, anyone nearby can join, and messages are kept, stored encrypted on this computer.",
  "setup.communityNote": "The network carries on after a restart, with its messages, until you erase it.",
  "setup.customTitle": "Choose every setting myself",
  "setup.customBody": "Starts with the standard settings. You set everything else in LOAM's admin settings.",
  "setup.storageTitle": "How should messages be stored?",
  "setup.storageBody": "This is how the messages kept on this computer are protected. It can't be changed later without starting a new network.",
  "setup.keychainMissing":
    "This computer has no keychain LOAM can use (on Linux, a secret service such as GNOME Keyring or KWallet), so a key can't be kept safely here. Use a passphrase instead: you type it each time LOAM starts.",
  "setup.passphraseLabel": "Passphrase",
  "setup.passphraseHint": "At least {min} characters. It is never stored: if you forget it, the messages can't be opened.",
  "setup.passphraseConfirmLabel": "Type it again",
  "setup.passphraseMissing": "Choose a passphrase.",
  "setup.passphraseShort": "Use at least {min} characters.",
  "setup.passphraseLong": "Use {max} characters or fewer.",
  "setup.passphraseMismatch": "The two passphrases don't match.",
  "setup.ackRequired": "Tick \"I understand\" to start the network.",
  "setup.start": "Start the network",
  "setup.starting": "Starting…",
  "setup.failed": "Couldn't start: {error}",

  // Encryption modes
  "encryption.off": "No encryption",
  "encryption.offBody": "Messages are stored as plain files that anyone with access to this computer can read. For testing or seeing how LOAM works.",
  "encryption.ephemeral": "Only while running",
  "encryption.ephemeralBody":
    "A new key every time the network starts, held only in memory. Once LOAM stops, nothing it stored can be read, and the next start begins empty.",
  "encryption.passphrase": "With a passphrase",
  "encryption.passphraseBody":
    "You type the passphrase each time LOAM starts. The messages survive a restart but stay locked until it is entered.",
  "encryption.persistent": "Kept in this computer's keychain",
  "encryption.persistentBody":
    "A random key kept by this computer's keychain. The network carries on after a restart, encrypted on disk. Recommended.",

  // The host note (the TUI's "You run this network" text: packages/tui/src/app.ts)
  "hostNote.title": "You run this network",
  "hostNote.stored": "What people post is stored on this computer, and you're responsible for it.",
  "hostNote.reports": "Check reports in the web app, and remove anything that breaks LOAM's rules.",
  "hostNote.child": "If you find sexual content involving a child, remove it and report it to the police.",
  "hostNote.more": "More: loamnet.com/child-safety",
  "hostNote.agree": "I understand",

  // Unlock
  "unlock.title": "Unlock {name}",
  "unlock.titlePlain": "Unlock your network",
  "unlock.body": "This network's messages are locked with a passphrase. Type it to start the network.",
  "unlock.label": "Passphrase",
  "unlock.wrong": "That passphrase didn't open the network. Check it and try again.",
  "unlock.missing": "Type the passphrase.",
  "unlock.submit": "Unlock and start",
  "unlock.working": "Unlocking…",
  "unlock.freshTitle": "Choose a new passphrase",
  "unlock.freshBody":
    "Emergency Reset erased this network, so it starts again empty. Choose the passphrase for the new network: you type it each time LOAM starts. It is never stored, so if you forget it, the messages can't be opened.",
  "unlock.freshSubmit": "Start the new network",
  "unlock.freshWorking": "Starting…",
  "unlock.forgotTitle": "Forgot the passphrase?",
  "unlock.forgotBody": "Without it the messages can't be opened by anyone. You can erase this network and start a new one.",

  // Busy states
  "busy.starting": "Starting the network…",
  "busy.startingBody": "This takes a few seconds.",
  "busy.resetting": "Erasing everything…",
  "busy.resettingBody": "Emergency Reset is running. Keep LOAM open until it finishes.",
  "busy.loading": "Opening LOAM…",

  // Stopped
  "stopped.title": "{name} is stopped",
  "stopped.titlePlain": "The network is stopped",
  "stopped.body": "Nobody can join or send messages until you start it again.",
  "stopped.ephemeral": "This network kept its messages only while it ran, so it starts again empty.",
  "stopped.start": "Start the network",

  // Running
  "running.status": "Running",
  "running.scan": "Scan to join from a phone or laptop on the same network as this computer.",
  "running.qrUnavailable": "This address is too long for a join code. Share the address below instead.",
  "running.keyNote": "The code carries this network's key, so the join is protected.",
  "running.inviteNote": "The code also lets people in without waiting for approval. It changes every 10 minutes.",
  "running.noAdmin": "Nobody is admin yet. Open LOAM on this computer to become admin.",
  "running.connectedNone": "No one has joined yet",
  "running.connectedOne": "1 phone connected",
  "running.connectedMany": "{n} phones connected",
  "running.people": "{total} people, {online} online",
  "running.peopleOne": "1 person, {online} online",
  "running.pending": "{n} waiting for approval",
  "running.resetting": "A reset is running or didn't finish. If this stays, stop the network and start it again.",
  "running.open": "Open LOAM",
  "running.display": "Display mode",
  "running.link": "Link another LOAM node",
  "running.stop": "Stop network",
  "running.stopping": "Stopping…",
  "running.stopEphemeral": "This network keeps its messages only while it runs: stopping it erases them for good.",
  "running.stopHold": "Hold to stop and erase",
  "support.open": "Support LOAM",
  "support.title": "Support LOAM",
  "support.body":
    "LOAM is free and open source, and always will be. Building it costs money all the same: test phones and laptops, app store fees, code signing, and the time to keep it working. If LOAM is useful to you, a coffee on Ko-fi helps keep it going.",
  "support.kofi": "Open Ko-fi",
  "running.closeNote": "Closing this window keeps the network running. Quit LOAM to stop it.",

  // Display mode
  "display.heading": "Join {name}",
  "display.headingPlain": "Join this LOAM network",
  "display.exit": "Leave display mode",
  "display.exitHint": "Press Esc to leave.",

  // Link another node
  "link.title": "Link another LOAM node",
  "link.body":
    "On the other LOAM phone, choose \"Join another LOAM network\" in LOAM's setup and scan this code. It works once, for 10 minutes, so show it only to the phone you want to link.",
  "link.sameNetwork": "That phone needs to be on the same network as this computer first.",
  "link.summary": "Public channels sync both ways; direct messages and private channels stay where they are.",
  "link.loading": "Making a link code…",
  "link.failed": "Couldn't make a link code: {error}",
  "link.noKey": "This network has no key to put in the code, so it can't be linked from here.",
  "link.expires": "Works once, until {time}",
  "link.again": "New code",

  // People
  "people.title": "People",
  "people.summary": "{total} people, {online} online",
  "people.summaryOne": "1 person, {online} online",
  "people.note": "Approvals, bans and channels are in the web app (Open LOAM).",
  "people.notRunning": "Start the network to see who has joined.",
  "people.empty": "Nobody has joined yet.",
  "people.loadFailed": "Couldn't load the people on this network: {error}",
  "people.joined": "…{id}, joined {time}",
  "people.online": "Online",
  "people.offline": "Not online",
  "people.admin": "Admin",
  "people.waiting": "Waiting",
  "people.banned": "Banned",
  "people.sameName": "Same name as someone else",
  "people.makeAdmin": "Make admin",
  "people.confirmTitle": "Make {name} an admin?",
  "people.confirmSameName":
    "Someone else uses this name too. Check the id ending before you go on: to make yourself admin, use Open LOAM instead.",
  "people.confirmPending": "They are waiting for approval; this lets them in too.",
  "people.confirmBody":
    "Admins can change every setting, remove people and wipe the network. This can't be undone from LOAM: an admin stays an admin.",
  "people.done": "{name} is now an admin.",

  // Activity
  "activity.title": "Activity",
  "activity.tunnelNote":
    "Joined devices send most of what they do inside one encrypted request (POST /api/transport/tunnel), so it isn't listed by path. That is on purpose.",
  "activity.errorsOnly": "Problems only",
  "activity.copy": "Copy",
  "activity.copiedAll": "Copied {n} lines",
  "activity.copiedSome": "Copied the newest {n} lines (the rest didn't fit)",
  "activity.empty": "Nothing yet. Requests show up here as people use the network.",
  "activity.emptyProblems": "No problems so far.",
  "activity.memoryNote": "Kept in memory only, never written to disk.",
  "activity.logLabel": "Log",

  // Settings
  "settings.title": "Settings",
  "settings.startupTitle": "When the network starts",
  "settings.portLabel": "Port",
  "settings.portHint": "Used the next time the network starts. If it's taken, LOAM tries the next ones. Leave it blank for 3000.",
  "settings.portInvalid": "Use a whole number from 1 to 65535.",
  "settings.joinHostLabel": "Join address",
  "settings.joinHostHint": "The address in the join code. Automatic picks the best one for this computer's network.",
  "settings.joinHostTextHint": "The address in the join code, as an IP address or a name. Leave it blank to pick one automatically.",
  "settings.joinHostAuto": "Automatic",
  "settings.joinHostInvalid": "Use an IP address such as 192.168.1.20, or a name such as loam.local.",
  "settings.logLevelLabel": "Activity detail",
  "settings.logInfo": "Normal",
  "settings.logDebug": "Detailed (for fixing problems)",
  "settings.saveFailed": "Not saved: {error}",
  "settings.assistantTitle": "Assistant",
  "settings.assistantBody":
    "An optional chat assistant people on the network can message. It can run through Ollama on this computer, through a chat service such as OpenRouter or OpenAI (an internet connection and a key from the service), or stay off. Set it up in LOAM's admin page.",
  "settings.assistantOpen": "Set up the assistant",
  "settings.assistantNotRunning": "Start the network to set up the assistant.",
  "settings.securityTitle": "Encryption",
  "settings.storage": "Messages on this computer",
  "settings.connections": "Connections",
  "settings.transportOptional": "Encrypted for everyone who joins by the code",
  "settings.transportRequired": "Encrypted only: unencrypted connections are refused",
  "settings.transportOff": "Not encrypted (Developer Mode)",
  "settings.storageFixed": "Fixed when the network was set up. Start a new network to change it.",
  "settings.unknown": "Not set up yet",
  "settings.dataTitle": "Data folder",
  "settings.dataBody": "Where this network keeps its database, pictures and settings.",
  "settings.openDataFolder": "Open data folder",
  "settings.version": "LOAM {version}",
  "settings.resetTitle": "Emergency Reset",
  "settings.resetBody":
    "Erases every message, person, channel and file on this network now, on this computer and on every phone connected to it, and signs everyone out. Settings are kept. This can't be undone.",
  "settings.resetNotRunning": "Start the network to run Emergency Reset.",
  "settings.resetHold": "Hold to erase everything",
  "settings.resetDone": "Emergency Reset done: everything from before is gone.",
  "settings.resetJournaled": "The reset was recorded and finishes when the network starts again.",
  "settings.resetUnrecorded":
    "The reset could not be recorded and did not finish. Start the network again, then run Emergency Reset again.",
  "settings.resetFailed": "Couldn't erase: {error}",
  "settings.newTitle": "Start a new network",
  "settings.newBody":
    "Permanently erases this network (every message, picture and person on it) and goes back to setup. This can't be undone.",
  "settings.newHold": "Hold to erase and start over",
  "settings.newFailed": "Couldn't erase this network: {error}",

  // Updates (tap-only: apps/app/src/components/update-notice.tsx)
  "update.title": "Updates",
  "update.check": "Check for updates",
  "update.checking": "Checking…",
  "update.current": "You have the latest version ({version}).",
  "update.newer": "LOAM {latest} is available. This computer has {current}.",
  "update.download": "Download",
  "update.offline": "Couldn't reach GitHub. Check this computer's internet connection and try again.",
  "update.timeout": "GitHub took too long to answer. Try again later.",
  "update.badResponse": "GitHub's answer didn't make sense. Try again later.",
  "update.note": "This asks GitHub for LOAM's latest version number. GitHub sees this computer's internet address; nothing else is sent.",

  // Failed
  "failed.retry": "Try again",
  "failed.newNetworkTitle": "Or start again",
  "failed.newNetworkBody": "Erases this network and everything on it, then goes back to setup. This can't be undone.",
  "failed.newNetworkHold": "Hold to erase and start over",
  "failed.newNetworkFailed": "Couldn't erase this network: {error}",
  "failed.download": "Open the download page",
  "error.port_in_use.title": "The port is already in use",
  "error.port_in_use.body":
    "Another program on this computer is using the port this network is set to. Close that program, or choose another port in Settings, then try again.",
  "error.port_unavailable.title": "No free port",
  "error.port_unavailable.body":
    "LOAM couldn't find a free port near the one it prefers. Choose another port in Settings, or restart the computer, then try again.",
  "error.db_encryption_driver_missing.title": "Encrypted storage isn't available",
  "error.db_encryption_driver_missing.body":
    "LOAM's encryption module didn't load on this computer, so the network didn't start. Nothing was stored unencrypted. Try again, reinstall LOAM, or start a new network.",
  "error.db_encryption_locked.title": "The messages couldn't be unlocked",
  "error.db_encryption_locked.body":
    "The network's database didn't open with the key LOAM has for it. Its key may be lost, or the passphrase was wrong. Without the right key the messages can't be read, so you can start a new network.",
  "error.db_unreadable.title": "The messages can't be read",
  "error.db_unreadable.body":
    "This network's database is damaged and couldn't be repaired. Try again; if it keeps happening, start a new network.",
  "error.keychain_unavailable.title": "The keychain isn't available",
  "error.keychain_unavailable.body":
    "This network's key is kept in this computer's keychain, which LOAM can't reach right now. Unlock the keychain (on Linux, start your secret service) and try again, or start a new network with a passphrase.",
  "error.client_missing.title": "LOAM's files are incomplete",
  "error.client_missing.body": "Part of LOAM is missing from this computer. Download and install LOAM again.",
  "error.reset_incomplete.title": "Emergency Reset didn't finish",
  "error.reset_incomplete.body":
    "Some data may still be on this computer, so the network stays locked. Try again to start it, then run Emergency Reset again; or erase it all now by starting a new network.",
  "error.stop_timeout.title": "The network didn't stop",
  "error.stop_timeout.body":
    "LOAM waited for the network to stop, but it is still shutting down, so nothing else can start yet. Try again in a moment. If it keeps happening, quit LOAM and open it again.",
  "error.unknown.title": "The network stopped unexpectedly",
  "error.unknown.body": "Something went wrong. Try again; the Activity screen may say more.",
} as const;

export type StringKey = keyof typeof en;

/**
 * The text for `key`, with each `{name}` filled from `values`. A placeholder with no value is left as it is,
 * so a missing value shows up in testing rather than as an empty gap.
 */
export function t(key: StringKey, values?: Record<string, string | number>): string {
  const template: string = en[key];
  if (!values) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
