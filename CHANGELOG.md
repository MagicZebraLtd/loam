# Changelog

All notable changes to LOAM are recorded here. LOAM is a local-first, off-grid messaging app (see
`README.md` and `MISSION.md`). Format loosely follows [Keep a Changelog](https://keepachangelog.com);
the project is pre-1.0, so the surface can still change. Dates are UTC.

## [0.8.0] - 2026-11-27

A security and privacy release: the fixes from November's security reviews, external and internal, and from a
release-readiness review of the result. Every network hosted from the Android app now accepts only
encrypted connections, the desktop app moves to Electron 45, and addresses carry the screen after `#/`. The
Google Play bundle is `versionCode` 14.

### Before you update
- **Android hosts: on a network that keeps its data, you come back as a new person.** The app now opens LOAM
  at `http://127.0.0.1:3000` instead of `http://localhost:3000`, and a browser keeps a sign-in per address.
  After the update you see the Welcome screen again and get a new name. You are admin again at once. Your
  old record stays in People with your old name, your direct messages and the private channels you owned.
  Before updating, hand each private channel you own to another member (Members, Make owner), so they can
  invite you back afterwards. After updating, an admin can still pass a channel's ownership to someone who is
  already in it. A Private and short-lived network starts empty every time, so nothing changes there.
  Members who joined by scanning the code keep their identity. The desktop app is not affected. (docs/04)
- **Phone-hosted networks: members who typed the address get a new identity** once they scan the code, and a
  typed address now only shows the scan screen. A laptop that can't scan opens the whole join link from the
  host's share screen ("Share or copy the link"). (docs/08)
- **`loamnet`: "Open on this device" is now `http://127.0.0.1:<port>`**, not `http://localhost:<port>`. To
  your browser that is a different site, so there you are a new person until you use the admin link again.
  Your old admin identity is still at `http://localhost:<port>`. On an `--encrypt` node, open that old address
  once (or clear its site data in the browser): the earlier version kept an unencrypted copy of what it
  showed there, and the new version removes it when that address is opened. (docs/14)
- **`loamnet` users update from 0.6.0**, since 0.7.0 was not published to npm. Everything under 0.7.0 below
  is new to you as well, and members are asked to agree to the rules once more.
- **Mesh mail does not cross between this version and 0.3.0 to 0.7.x**, in either direction. Update every
  node that exchanges it together. Public sync between an updated node and one still on 0.7.0 keeps working.
- **Reload any LOAM tab left open across the update.** An open tab keeps working, but it runs the old app
  until it is reloaded, and it can't message the assistant.
- **An Emergency Reset now turns sync off** on every kind of network, and it stays off until an admin turns
  it on again. See "Sync after a reset" in docs/02.
- **Assistant settings that are now refused.** On a phone-hosted network, an `http://` address on another
  computer (use `https://`). On every network, a service that answers with a redirect. On a Private network,
  a `.localhost` name. An admin who moved a chat service to another address earlier has to enter its key
  again.
- **How to update.** Google Play updates the Android app by itself. The APK from GitHub and the desktop app
  are installed over the old one by hand. For `loamnet`: `npm install -g loamnet`.

### Security
- **A reply can no longer test whether a post exists in a channel you can't see.** A reply naming a post in
  another channel was refused with its own answer, different from the one for a post that doesn't exist, so
  a member could try ids from private channels. Both now get the same answer (`parent_not_found`);
  `parent_wrong_channel` is gone. (docs/12)
- **A linked network's author record can't keep a local person's old picture or copy a name.** A peer's
  record for a post's author could name one of this network's uploaded pictures, which then stayed on disk
  and kept being served after its owner had replaced it, and could carry a generated look or a name copied
  from someone here. An imported author now never keeps an uploaded picture, loses a generated look copied
  from another record, and gets the generated name for its id when its name is blank or reads as someone
  else's or the assistant's. If someone here already uses that generated name, part of the id is added to
  it. Records an earlier version imported are repaired at start, and exported records
  no longer carry a local picture's id. (docs/11)
- **A used link code can't hand over a new sync token.** A repeat of a used link request, from the same
  address, port and key, was answered with the network's current sync token, even after an admin had removed
  that peer or turned sync off. A repeat is now answered only while sync is on and that peer is still
  listed; otherwise it is refused like any used code. (docs/11)
- **Android host: a link in a message opens in the browser or not at all.** The WebView's address list sent
  any address outside it straight to Android, which never asked the app, so the app's own check never ran
  for outside links and an `intent:` or `tel:` link could open another app. The app now decides every
  navigation itself: LOAM's pages load, other `http` and `https` links open in the browser, and every other
  kind of link is refused. Opening a screen or a conversation from a notification acts only on LOAM's own
  page. Not yet verified on a physical phone. (docs/04)
- **`loamnet`'s local links go to the port LOAM holds.** With `CLIENT_PORT` set apart from `PORT` (a proxy in
  front, say), the terminal UI's "Open as admin" link and plain mode's admin link used the advertised port,
  which LOAM doesn't hold, and carried the one-time admin code there. Local links now use the port and an
  address the server listens on. With `HOST=localhost` the start-up port check now looks at both loopback
  addresses, so the link can't reach another program that already held the port on `127.0.0.1`. (docs/14)
- **Every network the Android app hosts now requires encryption.** Whatever the network's security profile,
  a phone-hosted network accepts only encrypted connections, so everything members post or receive is
  encrypted, pictures and files included. (The web app itself and the public network settings it starts
  from still load unencrypted, as on every LOAM network: docs/08.) Someone who opens the address without
  the code is asked to scan it; the share screen now prints the whole join link, key included, with a
  button to share or copy it, for a laptop or a phone that can't scan. The key in the code is public, not a
  password: who may join is still the network's join setting. Members who joined a phone-hosted network
  by typing its address get a new identity after the upgrade, once they scan the code: their old one was
  tied to an unencrypted sign-in cookie. Syncing with networks linked by a code was already sealed both
  ways; a peer added by hand could fall back to unencrypted sync on a Community network, and now can't.
  The desktop app and `npx loamnet` are unchanged. (docs/08)
- **On a network the Android app hosts, an assistant on another computer must use HTTPS.** Saving an `http://`
  Ollama or chat-service address that isn't on the phone itself is refused (`llm_unencrypted_not_allowed`),
  the Test button won't send the key to one, and no redirect is followed. A network that already has one
  starts with the assistant off; the admin's Assistant settings say why, and every other setting still
  saves. (docs/06)
- **A member's sign-in is no longer sent to a different network at the same address.** Two LOAM networks
  can sit at the same address (the same IP and port at different times or places). The app kept a member's
  sign-in token per address only, so when they accepted a second network's code there, the app sent the
  first network's token to the second host, which could then use it on the first network. The token is now
  stored with the host key it was issued under and only goes to a session with that key; accepting a new
  key starts a fresh identity. A token saved by an earlier version is tied to the key the device held at
  the time. (docs/20)
- **A message to the assistant is refused if the assistant has moved since the sender last saw where it
  runs.** If the host switched a local model to an online service while a member was typing, and that
  member's screen had not yet heard, the question went to the online service without the notice. Each
  message to the assistant now names the destination the sender was shown; when it has changed the network
  refuses the message, nothing is stored or sent, and the app keeps the draft and shows the new destination
  first. A tab left open across this update has to reload before it can message the assistant. (docs/06)
- **The assistant follows no redirect, on any network.** Outside Private networks and the Android app, a
  service that answered with a redirect could move a member's question and chat history to an address
  other than the one members were told. No request to an assistant follows one now. A service behind a
  redirect (http to https, for one) needs its final address in the settings; until then the chat shows the
  usual failure line and Test connection reports a bad response. (docs/06)
- **A saved chat-service key is only sent to the address it was saved for.** The key is write-only, but an
  admin could point Test connection at another address, or change the saved address, and the saved key
  went there. Test connection now uses the saved key only for the saved address, and saving a different
  address without a new key removes the saved one. The admin page and the `loamnet` Settings screen say so.
  A change of path on the same address keeps the key. The removal holds across a restart: a key in
  `config.json` is never paired with a saved address on another origin, so a network whose address was
  moved that way on an earlier version needs its key entered again. (docs/06)
- **An assistant's service can't make a network hold an answer of any size.** A reply is cut at 64,000
  characters with a note saying so, a single streamed line over 256 Ki characters fails the reply (also when it arrives whole), the
  model list is read up to 8 MiB, and a failed answer's body is read for its first 4 KiB only.
- **An address ending in `.localhost` no longer counts as this computer.** Only `localhost` and loopback
  addresses do. Other `.localhost` names are looked up like any name and can answer from another machine,
  so such an assistant address is now treated as an online service: members see the online notice, and a
  Private network refuses it. (docs/06, docs/09)
- **An open search shows what the conversation shows.** The Search screen kept its own copy of results, so
  a deleted message, one a moderator removed, an expired one, or one in a private channel the member had
  just lost stayed readable there. Results now follow deletes, edits and lost channels as they happen, are
  pruned by the same retention rule as conversations, and are fetched again after each reconnect.
- **Android host: a message notification goes when its message does.** A notification kept showing a
  message's text after the message was deleted, edited, removed by a moderator or expired, until LOAM was
  opened. It is now removed, and so is a channel's notification when the host's person leaves or loses the
  channel, or a notified author is shadow-banned. The record behind this holds 256 messages and never
  forgets one whose notification is still showing. Android's own notification history, if it is switched
  on, is outside the app's reach. Not yet verified on a physical phone. (docs/04)
- **A link in a message can't carry a join key or a code.** Links were already stripped of a `#k=` key,
  but a tab or line break inside the link got one past the check, because browsers remove those before
  opening it. The check now reads the link as the browser will, and also drops admin, invite and
  node-link codes (`#a=`, `#i=`, `#l=`). (docs/08)
- **One device can no longer mint identities without limit over IPv6, or lock others out of an invite.**
  The limit on new identities counted each address, and a device on an IPv6 network can use any address in
  its subnet. It now also counts the subnet (eight times the per-address limit). The invite-code limit
  counted the whole subnet, so ten wrong tries from one phone blocked everyone; it now counts each address.
- **Pictures and files in a data folder you made yourself are private to the account that runs LOAM.** A
  folder LOAM creates was already private, but in one you created (usually readable by other accounts on
  the computer) the `avatars/` and `attachments/` folders and their files were readable too. They are now
  0700 and 0600, and existing folders are tightened at start, before the database is opened, so a start
  that stops at a locked database is covered too. An old recovery folder is tightened when a start-fresh
  is resumed. (docs/12)
- **Nobody can follow a network without a user record or approval.** A first message to the assistant from
  a browser with no sign-in cookie got a new cookie but no user record. That session received public
  channels live while it sat in no member list and no approval queue, so on an approval-only network it
  read along without being let in. Posting now creates the record and answers a banned or waiting person
  with a refusal first, the socket refuses a session with no record, and such a session receives nothing
  but the reset notice. Ending a session also closes that person's open connections. (docs/20)
- **A node admin can't add themself to a private channel.** Admins manage private channels without being
  in them, but they could invite themself, approve their own join request or take ownership, and then read
  the channel. Adding anyone to a private channel now needs the caller to be in it already; an admin
  outside it gets `channel_members_only`. Outside admins can still list members and requests, deny a
  request, remove a member, rename, archive, delete, and hand ownership to an existing member. They also
  still see the channel's name, owner and member list. (docs/12)
- **A browser that joined by code never sends a message or a typing notice unencrypted.** Until the
  network's settings had loaded, a browser that joined with the join code could send its first typing
  notice or message in the clear, on a slow node especially. Now a browser that holds the network's key
  refuses unencrypted requests, sockets and socket messages from the moment the page loads. A browser whose
  saved key can't be read is treated the same way until it has an encrypted session, and a failed
  handshake doesn't lift that. (The page
  itself and the public start-up settings still load unencrypted, as on every LOAM network.) Keys are
  compared in one spelling, so a key written another way can't pass as a different one. (docs/08)
- **A forged handshake can't leave a socket open that takes unencrypted messages.** Someone on the Wi-Fi who
  answered a member's handshake with another key broke the encrypted session, but the member's live socket
  wasn't told, and it went on accepting unencrypted messages, a fake reset notice included. Every path that
  drops the session now tells the socket, and a socket opened under encryption never takes an unencrypted
  message. A new socket also sends a random value that the node repeats inside its sealed challenge, so an
  earlier connection's challenge and messages can't be replayed onto it. A message that skips a number in
  the sequence closes the socket, and the app reconnects and catches up. (docs/20)
- **A sealed answer can't be passed off as the answer to a different request.** The node sealed a reply
  under the request's address as written, `#` included, though it routed the request without it. So the
  refusal of `POST /api/session/resume#1#401` was sealed exactly like a real 401 to a sign-in. Someone on
  the Wi-Fi could replay it to a member's real sign-in, and the member's app dropped its identity and came
  back as a new person. An address with `#` in it is now refused before anything is sealed. Current apps ask
  for, and accept only, answers sealed under labelled forms that no address can produce. A tab left open
  across the update still works. (docs/08)
- **A conversation's id no longer appears in the page address.** Screens were real paths (`/dm/<id>`,
  `/channel/<id>/thread/<id>`), so a reload, a restored tab or a phone reloading a tab it had dropped sent
  the conversation's id to the node in clear HTTP, on a network that requires encryption too. The service
  worker meant to stop this can't run on a plain-HTTP LAN address. Screens now live after `#/`
  (`http://node/#/dm/<id>`), which a browser never sends, so a reload asks only for `/`. An old address or a
  bookmark still opens and is rewritten in place, though that first request carries its path once.
  (docs/08)
- **Mesh mail is bound to the person it was written to.** The signature inside sealed mail didn't cover the
  recipient's key. Someone who was a contact of both A and C could give A a card with their own keys and C's
  mailbox token, read A's mail to "C", and seal it on to C, who stored it as a direct message from A. Mail
  now uses version 2 of the signature, which covers the recipient's key, and a swapped token only makes the
  mail undeliverable. Mesh mail does not cross between this version and 0.3.0 to 0.7.x, in either
  direction: mail an older build sent is never delivered here, and the other way round. Mesh is off by
  default. (docs/16)
- **An encrypted network's temporary files stay in memory.** Once a network held more than about 16 MB of
  messages, sorting them at start made SQLite spill rows to a temporary file. With the encrypted database
  driver, that file went to the computer's own temp folder unencrypted, outside the data folder, where an
  Emergency Reset doesn't reach. Every database now keeps temporary storage in memory. (docs/01)
- **No request can write through an Emergency Reset.** A request that had arrived before a reset, and whose
  body was still coming in, could write into the fresh database afterwards, bringing back a message or a
  pre-reset person. A reset now empties memory and closes every connection before anything else, and the
  node refuses any request that arrived before the reset started. A reset on an unencrypted network also
  deletes the stored network key, so a power cut right after it can't bring the old join code back. In
  members' browsers a reset now clears everything the page holds (direct-message list, read markers,
  typing, who is online, notices), and a device whose encrypted session had already died can still revoke
  its sign-in during a reset. (docs/02)
- **Android host: the admin token and the network key go only to LOAM's own page.** The app relied on the
  WebView's navigation check, which lets a page load if the app doesn't answer within 250 ms. A page from
  elsewhere that got in that way was handed the host's admin token and the network key. Both are now set
  only for LOAM's own page, messages from any other page are ignored, and a foreign page is stopped and
  LOAM loaded again. The node also accepts the host token only from the phone itself; from any other
  address it is a wrong secret and counts toward the limit on tries. (docs/04)
- **Android host: notifications and setup don't outlive the network.** A message notification left by an
  earlier run stayed until LOAM was opened, and its text was copied to a paired watch. Notifications are
  now cleared at start and when LOAM is swiped away, and stay on the phone. Closing after an Emergency
  Reset run from the app now deletes the setup record, so setup no longer names or fills in the erased
  network, and deletes every cookie and all of the WebView's storage. Passphrase fields no longer offer autofill.
  The swipe-away, watch and storage changes are not yet verified on a physical phone. (docs/04)
- **The terminal UI's admin link opens on `127.0.0.1` and ends when you close it.** The link used
  `localhost`, which can resolve to `[::1]` first. LOAM listens on IPv4, so another account on the computer
  could listen on `[::1]` at the same port and read the admin code from the link. The local link, the
  admin link and plain mode's "Open on this device" now use `127.0.0.1`. The admin code used to stay valid
  for 10 minutes even if no browser used it; it is now retired when its panel closes. (docs/14)
- **`loamnet` keeps the database key out of the programs it starts.** The browser the terminal UI opens
  inherited `LOAM_DB_KEY` and the other `LOAM_` values from its environment. `loamnet` now deletes the key
  once the server has started and starts the browser with no `LOAM_` values. It also defaults `NODE_ENV`
  to `production`, so a `LOAM_DEV_MODE=1` left in the shell can't turn encryption off. The diagnostics file
  now hides addresses that carry a port. (docs/14)
- **The desktop app's member window closes when the network stops.** It stayed open on its "can't reach"
  page, and a reload, which that page offers, could load another program's page at the same port into the
  window that holds the host's identity. Open it again from the host window or the tray. The app itself now
  also holds a new network's passphrase to 8 characters. (docs/24)
- **A member can't take another person's name or look.** A profile edit accepted a copy of someone else's
  name, or the assistant's, written with other case, spacing or hidden characters, and an avatar seed equal
  to someone's id or seed. Together they made a second person who looked the same on every screen. Both
  are now refused (`display_name_taken`), a name made only of hidden characters is refused, and a seed you
  already have is kept. A replaced profile picture is deleted at once, not at the next restart. (docs/12)
- **Moderators can remove only messages they can see.** A moderator or admin could remove a message from a
  direct conversation or a private channel they weren't in, by its id. Removal now needs the moderator in
  the message's audience, or a report in their queue that points at it; otherwise the answer is the one for
  an unknown id. Applying or lifting a shadow ban no longer sends anyone an update, so the member's own
  connection can't reveal it. (docs/12)
- **Editing, deleting or reacting can't tell anyone a message exists.** These answered differently for a
  message outside the caller's audience than for no message, so a member could test ids from other
  people's conversations. They now answer as for an unknown id, and a reaction to a reaction is refused.
  Mesh senders are left out of the moderation list, and the routes that act on people, and a direct message
  or report from someone they never mailed, treat them as unknown. (docs/12)
- **Resolved reports are deleted after the network's retention.** A resolved report kept who reported whom
  and both notes for as long as the network ran. It is now deleted once its resolution is older than the
  message retention, or after 30 days when messages are kept. Open and escalated reports are never
  deleted. (docs/12)
- **Read markers go when their conversation goes.** The browser kept the time a member last read each
  conversation, and the last one they opened, after the messages were deleted or the channel lost, which
  named who they talked to and when. These are now pruned when a channel is removed, after a reconnect for
  channels the network no longer lists, when the direct-message list arrives for people no longer in it
  (also after the last direct message with someone is deleted while the app is open), and in full for a
  banned or waiting member. (docs/02)
- **A change of the assistant's destination cuts its history even after a clock change.** The cut-off was
  the host's clock, so with the clock set back, older turns counted as written after the change and went
  to the new service. It is now the later of the clock and just after the newest message with the
  assistant. `http` and `https` on one host now count as two destinations, so switching between them is a
  change members are told about. (docs/06)
- **Request logs name the route, not the conversation.** Each log line carried the full path
  (`/api/dms/user.…`, `/dm/user.…`), which named who a member talked to beside their address, and the log
  outlives an Emergency Reset. Lines now carry the route's pattern (`/api/dms/:userId`), `[page]`,
  `[unmatched]` or `[tunnelled]`. An assistant service's own error text, which can quote a member's
  question, now goes to the debug log only, cut to 200 characters. (docs/02)
- **A member who joined by code gets the network's settings over the encrypted channel.** The app read the
  assistant's destination, the retention and the join address from the unencrypted start-up answer, which
  anyone on the path could rewrite, for example to show a false destination for the assistant. After signing in
  it now reads them through the encrypted tunnel; the unencrypted answer only says how to reach a session.
  (docs/20)
- **Sync follows no redirects and passes on no moderation state.** A peer could answer with a redirect and
  send the request somewhere else; any redirect now fails it. Exported author records no longer say who is
  banned or waiting for approval. Imports refuse a post with a location or attachments while that feature
  is off here, and a reaction to a reaction, and an imported author loses a peer's timeout. (docs/11)
- **The web app can open sockets only to its own network.** The page's security policy allowed sockets to
  any host. It now names only the host the page came from.
- **A downloaded file's name fits its type.** An attachment's name kept invisible and control characters
  and any extension, so a text file could arrive named `update.apk`. The name is now cleaned and ends with
  an extension that fits its declared type (`update.apk.txt`).
- **Message formatting shows no pictures and allows only its own tags.** `![alt](url)` loaded the address
  in every reader's browser, so a post with hundreds of them made each reader request them all. It now shows
  the alt text; share pictures as attachments. The sanitiser allows only the tags the formatter writes and
  the link address, so a malformed link can't carry other attributes.
- **A private-channel invite doesn't say who is banned or waiting.** An invite or handover naming a banned
  person got its own answer ("That user has been removed from this node"), and one naming a person still
  waiting for approval, or a mesh sender, went through. All three now get the answer for an unknown person
  (`user_not_found`). (docs/12)
- **A resolved report stays as it was resolved.** Resolving it again rewrote the decision and its time, so
  a moderator could overwrite another's (or an admin's) decision and keep the report from ever being
  deleted. It is now returned unchanged. (docs/12)
- **Names that differ only by characters that draw nothing count as the same.** Hangul fillers, the blank
  Braille pattern, variation selectors and tag characters got a copy of someone's name past the check, and
  a name made of them showed as blank. They are now ignored when names are compared (a stored name keeps
  them, since emoji use variation selectors), and a name that shows as blank is refused. They are removed
  before the names are normalised as well as after, so one placed between a letter and its accent no
  longer makes a new name. (docs/12)
- **Mesh mail waits for the member rules.** A member who hadn't agreed to the rules could still send mesh
  mail and broadcasts. They are now refused (`rules_not_accepted`), like posts. (docs/30)
- **The panic address refuses a flood before any hash check, and one token starts one reset.** Attempts on
  `POST /api/panic` were counted only on a network with a token set, and every attempt, over the limit or
  not, paid for a slow hash check. Attempts are now counted on every network and a caller over the limit is
  refused first. Two requests with the right token at once start one reset, not two. (docs/02)
- **One IPv6 device can't fill the admin-claim and panic limiter with addresses.** In a subnet that had used
  up its tries, each new address still got an entry before the subnet was checked. Such a subnet is now
  refused before its address is counted.
- **Desktop: the host window sends only LOAM's own pages to the browser.** A page that got into the host
  window could open any address in the computer's browser through a link or a new window. Only the pages
  LOAM knows (loamnet.com, the project's pages, the running network) go there now; the member window's links
  are unchanged. (docs/24)
- **Desktop: the launcher ignores `LOAM_REQUIRE_TRANSPORT_ENCRYPTION` from the shell.** It is the Android
  launcher's switch; the desktop app keeps the network's own transport setting. (docs/24)
- **The terminal UI's diagnostics drop every address's query and fragment**, where a code or a search term
  can sit.
- **An Emergency Reset turns sync off, on every kind of network.** A reset empties this network's record of
  what it deleted, so a linked network would have handed every public post straight back at its next round.
  The reset now turns sync off and keeps the list of linked networks. After a restart the sync token may be
  gone too, since it is not kept in the copy of the settings a restart begins from. The admin Sync panel says
  why sync is off, and it stays off until an admin turns it on again or removes every linked network. The
  linked networks keep their own copies of the public channels. (docs/02, docs/11)
- **Linking two networks by a code always ends with a sync token.** If the network showing the code had no
  token and no other linked network, it makes one and hands it over in the sealed answer, so a pair linked by
  code never syncs without one. The admin Sync panel warns when sync is on with no token. (docs/11)
- **Requests from other websites are refused.** A page on another site, open in a member's browser, could
  send that browser to a LOAM address. A request that changes something is now refused when it comes from
  another origin (403), and a form-style body is refused whatever its origin (415). (docs/12)
- **Browsers are told to keep no copy of what the node answers**, pictures included (`Cache-Control:
  no-store` on every `/api/` response). A page can't clear the browser's own cache, so an Emergency Reset
  could not reach what a browser had cached. (docs/02)
- **On an encrypted `loamnet` network, a browser on the host computer keeps no local copy** of messages. It
  kept one unencrypted, beside the encrypted database. (docs/02, docs/14)
- **Phones and browsers drop their cached messages once the network's retention has passed**, at start and
  every minute, including while away from the host. Retention is judged by the host's clock, which the node
  now reports, since a member's clock and the host's can be hours apart off-grid. (docs/07)
- **A member can hold at most 16 live connections, one address 64, and a node 1,024.** Further ones are
  refused. When a save makes a network require encryption, connections that aren't encrypted are closed at
  once. (docs/12)
- **A ban holds across a restart of the host.** A banned member's sign-in was removed from the database but
  not from memory, so after a restart their next visit made them a new, unbanned person. (docs/20)
- **A banned member can't become admin** with an admin link or code. (docs/12)
- **Android host: LOAM's own screen loads from `127.0.0.1`, never `localhost`,** which another app on the
  phone could answer for. See "Before you update" for what this does to the host's own identity. (docs/04)

### Changed
- **The admin page saves only what you changed.** It sent the whole form, so two admins, or an admin and the
  terminal UI, could undo each other's changes. It also re-reads the settings when they change elsewhere.
- **Addresses show the screen after `#/`** (`http://node/#/dm/<id>`, `#/admin?section=llm`). Old addresses
  and bookmarks still open.
- **Developer Mode under `loamnet` needs an explicit non-production `NODE_ENV`.** `LOAM_DEV_MODE=1` alone no
  longer turns encryption off there. (docs/14)
- **The desktop app runs on Electron 45** (it was 44). (docs/24)
- **A tagged release only ships a signed and notarized Mac app.** Without the Apple secrets a tag build fell
  back to ad-hoc signing, and an ad-hoc signed update can't read the keychain item the signed app made, which
  locks the host out of an encrypted network. A tag build now fails instead; a manual build keeps the
  fallback. The Android and desktop workflows also publish to a Release one after the other. (docs/24)
- **Android host: a passphrase that creates a database is asked for twice,** so a typing slip can't lock a
  new network. The recovery screens are translated, with the technical text behind Details. (docs/04)

### Fixed
- **A join link opened in a tab that already shows LOAM now joins.** With addresses now ending in `#/…`,
  pasting the whole link over the address changed only the part after `#`, the browser loaded nothing, and
  the key was dropped. A laptop that typed a phone-hosted network's address first could not get in that way.
- **A wrong clock no longer hides new messages on a network with a retention time.** Clients began removing
  expired messages by their own clock. A host whose clock was behind (a Raspberry Pi has no battery clock)
  made every new message look old, and it vanished from members' screens within a minute. (docs/07)
- **A channel with hundreds of pictures no longer locks a member out for a minute.** Members who joined by
  the code send every request through one address, one request per picture, and it shared the 300 a minute
  meant for everything else. It now has its own, larger allowance. (docs/08)
- **An Emergency Reset on a network set up only by `config.json` no longer stops that file being read.** The
  reset stored the whole running configuration in the database, where it overrode every later edit to the
  file: a new panic token or a stricter join setting was ignored. Only the sync pause is stored now. (docs/02)
- **Android host: choosing a new encryption setting on a running network waits for the next start.** It took
  effect at once: Ephemeral deleted the live database and its pictures, and Passphrase showed the host screen
  as locked while the network kept serving. (docs/04)
- **The on-device assistant no longer stops with "Context is full"** after a dozen or so turns: the chat's
  history is cut to what the model can hold. (docs/06)
- **`loamnet` says plainly when it can't open the database.** A wrong passphrase, or `--encrypt` on a
  database that isn't encrypted, ended in a stack trace. Nothing on disk was changed then or is now. (docs/14)
- **Photos from iPhones and Safari now send.** Safari, and so every browser on iOS, can't write WebP: asked
  for it, it hands back a PNG, which for a camera photo is far over the 256 KB limit, so nearly every photo
  failed. A picture now counts only when it comes back in the type asked for; where WebP is missing it is
  written as JPEG over white, at falling quality and then at smaller sizes. A very detailed photo is shrunk
  in WebP too, the profile-picture editor uses the same encoder, and the composer's picture errors are
  translated.
- **A phone that slept through an Emergency Reset reaches the "scan again" screen.** A phone that joined by
  code and was asleep or away during a reset came back to a network with a new key, stayed "Offline" and
  kept showing the old content until it was reloaded. It now opens no connection under the dead session and
  runs its start-up again, which shows the screen asking to scan the new code. (docs/08)
- **Denying a join request works on a phone that joined by code.** Every empty answer (a denied join
  request, a typing notice) failed in the encrypted tunnel, so denying always showed an error. Empty answers
  now arrive empty. A refusal from the tunnel itself (a replay, the rate limit) keeps its real status
  instead of a flat 400, and a tunnel answer is now bound in its seal to the request it answers, as direct
  requests' answers already were. (docs/08)
- **Android host: a reset finished on the next launch keeps the new setup.** When a fixed-key Emergency
  Reset was cut short and finished at the next launch, the app deleted the setup the host had just made and
  closed. It now clears the key and the WebView's data, keeps the new setup and starts the new network. A
  reset of a running network deletes the setup record before the key is cleared, so it is gone even if a
  later step fails. Only one key clear runs at a time, and no new key is made while one is running, so a
  slow clear and a retry can't delete the new network's key. Not yet verified on a physical phone. (docs/04)
- **Android host: a start-fresh that ends at the passphrase prompt reports no time-out.** Five minutes
  later the lock screen's details said `boot_timeout`. (docs/04)
- **Desktop: a "Start a new network" that fails part-way is finished, not booted.** A discard that stopped
  early (a file Windows still held open, say) left the network record, and the next launch could start an
  empty network under the old name. The discard now records itself before it resets or erases anything, a
  launch or Try again finishes it before anything starts, and a data folder that can't be emptied shows as
  a failure instead of closing the app. (docs/24)
- **Desktop: a crashed host window comes back.** It stayed blank while the network ran. It now reloads, up
  to three times a minute, and after that the tray opens a fresh one. (docs/24)
- **Desktop: a release candidate's update check sees the final release as newer.** A build from an `-rc` tag
  reported the bare version number. Tag builds now record their tag. (docs/24)
- **`loamnet` plain mode's admin link file is tidied.** A leftover `admin-link.txt` from an earlier run, whose
  code died with it, is removed at start, no link is made while a reset is under way, and a failure to write
  the file no longer stops the node. (docs/14)
- **Terminal UI:** a second `o` while the browser is opening is ignored, the "Open as admin" panel says the
  link also stops after 10 minutes, and the Model dialog no longer opens over another dialog.
- **A browser that can't save data keeps its identity for the page.** Where storage writes fail (a full
  quota, a WebView with none), a member who joined by code became a new person on every start-up pass. The
  identity is now kept in memory until the page closes, and so is one carried over from an earlier version
  when its rewrite can't be saved. (docs/20)
- **A search link runs once the app is connected.** A `#/search?q=` link opened before the app had its
  settings searched with no session and was never tried again. A reconnect that lands in the middle of a
  search now refreshes the results once that search has finished.
- **An expired invite code says so on a first visit**, not only on a later one.
- **Smaller fixes in the web app:** a settings reload no longer overwrites a newer live change, a saved
  network key is read in one spelling whatever version wrote it, and a sign-in answer that arrives after
  the network's key changed no longer replaces the new sign-in.
- **A thread whose first post is gone no longer leaves a narrow screen blank.** The thread view opens only
  while its post is there.
- **The installed app starts at `/`**, not the old `/channels` path, and keeps its identity, so an existing
  installation updates in place. A click on a navigation link with a
  modifier key or the middle button is left to the browser (a new tab or window), and going to the screen
  already shown adds no history entry.
- **Admin settings:** the assistant's system prompt can be cleared, and the reason the assistant is off
  stays on screen after a save.
- **Settings and the composer:** a generated avatar style can be picked while a photo is in use, a picture
  added while a message is sending is kept, a restored draft keeps its height, and picking the same avatar
  file again works. A network address too long for a link code says so instead of showing a blank tile.
- **A message that names one upload twice stores it once.**
- **A long-running node's name cache stays small.** The generated-name cache is emptied at 4,096 names.
- **An Emergency Reset that fails after its journal is cleared no longer says a restart will finish it.**
- **The Mac app now carries Electron's licence files** (`LICENSE.electron.txt` and `LICENSES.chromium.html`,
  in the bundle's Resources), as the Windows and Linux builds already did.

## [0.7.0] - 2026-10-25

The launch release: the desktop app's first release, the assistant through any OpenAI-style chat service,
and the fixes from two independent pre-launch reviews (one external, one internal) of the whole code base.
The Google Play bundle is `versionCode` 13.

### Security
- **The Android host keeps no plaintext copy of messages outside its encrypted database.** On an encrypted
  network the host app's own browser view now tells the web client to keep no local copy (the same
  `window.__loamHostNoLocalCache` the desktop app has set since it was built) and switches its page cache
  off, and the web client deletes the copy an earlier version of the app left behind the first time it
  loads. Pictures and files are also served with `Cache-Control: no-store` whenever the database is
  encrypted, so neither host window can cache them on disk. Phones that join a network are unaffected.
  Not yet verified on a physical phone (docs/21).
- **A hardened (Private) network now refuses an Ollama address off the local network** (judged by the address
  as written, as for a chat service: loopback, private and link-local addresses, `.local` and dotless names
  count as local), as it already
  refused an online chat service: the rule covers both backends when a setting is saved, at boot from a
  hand-edited `config.json`, and for the admin screens' Test connection. Requests from a hardened network to
  its assistant never follow an HTTP redirect either, so a local address can't hand the conversation to a
  public one. The admin page and the `loamnet` Settings screen now say so for an Ollama address too.
- **People are told where the assistant runs, in the assistant's own chat.** The network tells every client
  whether replies come from the host's phone, the host's computer, another computer on the local network,
  or an online service (`NetworkConfig.assistantDestination`, named by its hostname); the assistant's
  chat shows it under the name, and an online service shows a notice that each device confirms once before
  its first message goes out. When the host changes where the assistant runs, the earlier conversation is
  not sent along: the assistant's memory of each chat starts again from that change. Before, only the admin
  page said where messages went, and switching a local assistant to an online service could send up to 40
  earlier turns there with the next message.
- **The security claims are scoped to what the code does.** The transport encryption protects messages from
  anyone listening on the Wi-Fi and from a look-alike host at join time; it does not protect a phone from
  someone who can rewrite traffic while LOAM's page loads over plain HTTP, since the code that checks the
  key is the code being replaced. docs/08, SECURITY.md, the README, the site and both privacy policies now
  say so, and the site no longer says `--encrypt` encrypts "everything" (pictures and files are stored
  beside the database, unencrypted) or that a Private network "leaves nothing readable" (it throws away the
  key to its messages when LOAM stops; pictures and files are deleted the next time it starts). Deleting a
  message is removed here and refused on re-import by linked networks, but a copy they already pulled stays
  there; the operators' guide said otherwise.
- **The Android host no longer writes a line per request to the device log.** The embedded server's output
  goes to logcat, which sits outside the encrypted database and can be read with `adb` or from a bug report,
  and each request line carried a joiner's address and a timestamp. LOAM's own warnings and errors are still
  logged; they carry no message text, names or keys. The host app also stops logging the page URL on a load error.
- **Private channels get an opaque id** (`chan_<hex>`) instead of one made from their name. A channel's id
  lands where a reset can't reach (joiners' browser history, the host window's remembered last conversation,
  the plaintext paths of a client that skipped the QR code), so a name-derived id told anyone with that
  history that a hidden channel of that name existed. Public channels keep their readable slugs. Existing
  private channels keep the id they have.
- **The panic route takes the same time to answer whether or not a token is configured**, so a prober on the
  LAN can no longer tell an armed node from a plain one by timing the 404.
- **The host app's WebView opens links through its own navigation guard** (`setSupportMultipleWindows` off,
  so a `target=_blank` link can't be handed to a detached popup) and no longer asks for third-party cookies.
- **Electron 44.9.1** in the desktop app, which carries the mitigation for the compromised eMudhra
  intermediate certificates (GHSA-jr5w-w6x2-84p9).
- **Security reporting:** GitHub private vulnerability reporting is enabled for the repository and named in
  `SECURITY.md`, whose scope now lists the Android, desktop and terminal host apps.
- **Third-party licence notices ship with every build.** A generator (`scripts/third-party-notices.mjs`) writes
  the bundled open-source packages and their licence texts into `THIRD_PARTY_NOTICES.txt` beside the `loamnet`
  server bundle, the desktop app's and the Android host's, and the web client serves its own at
  `/third-party-notices.txt`, linked from Settings. Nothing is downloaded or committed; the files are made at
  build time (docs/14 "Licence notices").

### Added
- **The assistant can answer through an online or local chat service**, not only Ollama: OpenRouter,
  OpenAI, Groq, Mistral, LM Studio, llama.cpp server, or any other service with an OpenAI-style API. Admins
  pick where the assistant runs (off, Ollama, a chat service, or on the Android phone), choose a service by
  name, paste its key (kept on the host and never shown again, not even to admins), press Test connection
  to pick a model from the service's list, and are told plainly when messages to the assistant will leave
  the network. The same settings are in the `loamnet` Settings screen; the desktop app's Settings and the
  Android host's AI assistant screen open them. A hardened network only accepts a service on this computer
  or the local network. Off by default; nothing changes for a network that doesn't turn it on.
- **A desktop app for Mac, Windows and Linux** (`apps/desktop`, Electron). Open it, answer a few questions,
  and it shows the code people nearby scan to join; you are the network's admin, and closing the window keeps
  the network running until you quit. It has the same screens as the phone host (the code, display mode,
  linking another LOAM node, people, activity, settings, Emergency Reset) and keeps its network's key in the
  computer's keychain, or behind a passphrase, or only in memory. Installers: `LOAM-mac-arm64.dmg`,
  `LOAM-mac-x64.dmg`, `LOAM-win-x64.exe`, `LOAM-linux-x64.AppImage` and `LOAM-linux-x64.deb`, each with a
  checksum and a signed build record on the release. It never checks for updates by itself and sends nothing
  anywhere. The Mac builds are signed by Magic Zebra Limited and notarized by Apple, so they open with no
  "Open Anyway" step; the Windows installer is not yet signed (SignPath Foundation is the plan), and the
  Windows and Linux builds have not yet been run on real machines. This is its first release. See
  `docs/24-electron-desktop.md`.
- **A website page for the desktop app** (`/desktop`) and the code signing policy (`/code-signing`).

### Changed
- **The web client runs on Preact 11** (from 10.29). Refs now start explicitly empty, and the crash screen's alert
  role moved onto its card so the page keeps its `main` landmark. `preact-render-to-string` is pinned to 6.8, which
  Preact 11 needs.
- **The first-run setup choices (Private, Community, Choose every setting myself) now live in
  `@loam/schema`**, so the Android app and the desktop app set up a network from the same code and cannot
  drift apart. Nothing changes for the phone.
- **The server bundle recipe is shared**: `scripts/lib/bundle-server.mjs` is used by both the `loamnet`
  package build and the desktop app. The `loamnet` output is unchanged.
- **Stopping the node no longer waits for a request that never finishes.** The embedded server (the desktop
  app, the Android host, `loamnet` on Ctrl-C) closes its connections when it shuts down instead of waiting
  for every in-flight request, so a stalled upload can't hold a stop open for ever.
- **The web client keeps no local copy when the host app says not to** (`window.__loamHostNoLocalCache`):
  the desktop app sets it on every encrypted network, and from this release the Android host does too (see
  Security above), so the host's own window never writes messages to the disk outside the database's key.
  Nothing changes for phones joining a network.

## [0.6.4] - 2026-10-15

### Changed
- **Google Play and GitHub installs of the Android host are now signed with the same key**, so either one can
  update the other. Google Play now signs LOAM with Magic Zebra's own release key, the key that signs the APK
  on GitHub. The app is otherwise the same as 0.6.3. Anyone who installed an earlier test build from Google
  Play needs to uninstall it once and install again.

## [0.6.3] - 2026-10-13

### Added
- **Notifications for new messages.** Settings has a Notifications section: a sound and/or a buzz for direct
  messages (the default), every message, or nothing, saved on each device. Browsers don't allow real
  notifications from a plain-HTTP local network, so in a browser these play only while LOAM is open.
- **Android notifications on the host phone.** While LOAM is in the background, the host's own new messages
  show as Android notifications, one per conversation, following the same Settings choice. Sound and
  vibration follow Android's settings for LOAM's "Messages" category, the lock screen shows only "New
  message", and a tap opens the conversation. They stay on the phone, and an Emergency reset clears them.
  The notification permission LOAM already asks for covers them.

### Changed
- **"Try another name" on the Welcome screen is now a proper button**, with a border and a refresh icon. It looked like
  a label before.
- **The Android host counts "Devices connected"**, not "Phones connected", since laptops and tablets join too. In
  all 15 languages.

### Fixed
- **The Android host no longer closes itself when its server can't start.** It shows why instead. When another app on
  the phone already uses LOAM's port (3000), it says so in the phone's language and offers Retry, which starts
  the network once that app lets go. LOAM also stopped treating any answer on that port as its own server, and
  sends that app nothing, so another app can never get LOAM's window or its host token.

## [0.6.2] - 2026-10-13

### Changed
- **Two new rules: no nudity or sexual content, and no gore.** Graphic pictures or videos of violence or
  injuries are allowed only to get someone help. The rules are now version 2, so everyone already on a
  network sees the Welcome screen again and agrees once more before their next post. Google Play asks an
  app where people post to forbid what Play forbids. The Welcome screen, the full rules at `/rules` and
  all 15 languages have both.

### Fixed
- **The Android app no longer sends Google usage reports from the QR scanner.** The scanner that reads link
  codes in setup is Google's ML Kit, which reports the phone's model and Android version, the app's name
  and version, a per-install id, timings and error codes to Google, with no setting to turn it off. 0.6.0
  and 0.6.1 sent them, when the phone had internet, after the scanner was opened. 0.6.2 removes the
  library's upload route, so the reports are discarded on the phone. Nothing from a LOAM network was ever in
  them. Scanning works as before.
- The website's screenshot script works again: its demo people now agree to the rules before posting.

## [0.6.1] - 2026-10-12

### Changed
- **The Android app is now `com.loamnet.app`** (it was `com.loamnet.host`), the name it has on Google Play.
  Android treats it as a different app, so 0.6.1 does not update an installed 0.5.0 or 0.6.0 from GitHub: it
  installs beside it, and nothing carries over: the new app starts with the setup screens and a new,
  empty network. Uninstalling the old app permanently deletes everything its network stored on the phone
  (messages, pictures, files and settings), so keep it until that network is no longer needed. The web
  app, the server and `loamnet` are unchanged.

## [0.6.0] - 2026-10-10

The Play launch release: Welcome screen and network rules (18+), reports moderators can act on, Android
setup screens, display mode, link and invite codes, a terminal screen and kiosk mode for `loamnet`, support
for tablets and Android laptops, every finding of the 9 October 2026 review, and a long list of security
fixes.

### Added
- **A maskable app icon**, so Android's launcher shapes the installed web app's icon instead of shrinking it
  onto a white disc.
- **Tablets, foldables and Android laptops.** The Android host runs in portrait and landscape and in
  resizable windows: the portrait lock is gone, the main activity is declared resizable, and the
  touchscreen is declared optional so an Android laptop with only a keyboard and trackpad (the Googlebook)
  can install it. The boot and recovery screen and the host menu scroll in a short window, display mode puts
  its two join codes side by side whenever that makes them larger, Enter submits the text fields, and every
  native control takes keyboard focus and mouse clicks. Wi-Fi hosting mode works on a wired network too: a
  laptop docked on Ethernet advertises its wired address and the share screen says so. README and the
  website say "Android phone, tablet or laptop".
- **ARCHITECTURE.md, CONTRIBUTING.md and a code of conduct.** A human-facing map of the codebase with a
  classified index of the design docs, a contributor guide (setup, the three gotchas, the deliberate
  no-linter policy, how AI is used), the Contributor Covenant 2.1, and GitHub issue and pull-request
  templates.
- **Welcome screen and network rules.** Someone joining a network sees their random name and picture (with
  "Try another name" until they first agree), the rules in one sentence, and one button: "I'm 18 or over,
  and I agree". The full rules are at `/rules`, served by the network itself, offline, in all 15 languages.
  Until someone agrees, the server refuses their posts, reactions, uploads, typed names, edits and new
  channels; reading, reporting and blocking always work. Anyone who posted before the rules existed keeps
  their name.
- **LOAM is for adults (18+).** Not because of anything in it: there are no accounts and no company in the
  middle, so nobody can check ages. The README and website say why; child safety standards are at
  loamnet.com/child-safety.
- **Reports moderators can act on.** A message report shows moderators the reported message, read live
  (so it never outlives a deletion), with its pictures as thumbnails and files as links, and the report
  dialog says moderators will see it. **Escalate** passes a report to the admins. Moderators and admins
  see a live count of open reports on People.
- **"You run this network"**: a one-time note for hosts on the Android setup screen and in the `loamnet`
  terminal view (and on every plain-mode start), saying they are responsible for their network.
- **Update news on the Android host, without phoning home.** The Google Play build asks the Play Store app
  whether there is a newer LOAM; the GitHub build has a "Check for updates" link that asks GitHub only when
  tapped. Both show only on the opening setup screen, never while a network runs, and neither downloads
  anything.
- **About LOAM** on the Android host: the version, links to loamnet.com, the email and the source code, and
  the licence.
- **Saving received files on the host phone.** Tapping a file in the host's own window now opens Android's
  share sheet (it did nothing before).
- **Reporting problems.** LOAM has no analytics or crash reporting, so Settings, the privacy policy and the
  website say how to tell us: a GitHub issue or opensource@magiczebra.co.uk.
- **A terminal screen for `loamnet`.** In a terminal, `loam` now keeps the join QR on screen instead of
  scrolling it away under a line per request, with Activity, People, Settings and Debug screens a key
  away. Press `o` to open LOAM in the browser as the network's admin (or show a QR that makes a phone
  admin); change the main network settings live; make someone an admin; link another network; run an
  Emergency Reset; turn on detailed logging or write a diagnostics file. Messages and moderation stay in
  the web app. No new dependencies.
- **Kiosk mode** for a computer left out for people to join from: only the join QR, the network's name
  and the number of connected devices show until a password is entered. Press `k`, or start with
  `loam --kiosk`; Settings can make it start locked every time. It locks the screen, not the computer.
- **Emergency Reset deletes diagnostics files** the terminal view wrote to the data folder, and the
  terminal view forgets its log of who connected.
- **Linking networks both ways, with a link code.** An admin (web admin sync settings) or the host phone
  (share screen) can show a "Link another LOAM node" code. It works once, for 10 minutes. Another LOAM
  phone scans it in setup and the two networks then share their public channels both ways, with nothing
  else to approve. The ordinary join code can't link a node. Direct messages and private channels still
  never leave either network.
- **Invite codes for approval-only networks.** The host phone's join QR (share screen and display mode)
  carries a code that changes every 10 minutes. Someone who scans it is let straight in instead of waiting
  in the queue; a photo of an old code stops working within 20 minutes, and an Emergency Reset retires
  every code at once.
- **Setup screens on the Android host.** The first launch asks for a language, the kind of network,
  its name and how people connect (Hotspot or Wi-Fi). The kinds are plain choices:
  - **Private and short-lived:** random names and pictures, messages gone after an hour, each joiner
    approved, encrypted connections only, and messages stored under a key that exists only while the
    app runs (pictures and files are deleted the next time it starts).
  - **Community:** names and photos, open to anyone nearby, and messages kept, stored encrypted.
  - **Choose every setting myself:** opens the admin settings.

  Later launches show one screen: continue the last network in one tap, or start a new one (erasing the
  old one takes a press-and-hold).
- **Join another LOAM network from the setup screens.** Scan the other network's link code and this phone
  becomes another node of it, syncing public channels both ways. The camera is asked for only on that
  step.
- **Display mode on the Android host** (replacing the separate "Keep screen on" and "Kiosk mode"
  switches): one button on the share screen shows the join codes full screen, as large as the screen
  allows with no scrolling (one code on Wi-Fi; two on a hotspot, side by side in landscape), keeps the
  screen on and pins LOAM in front. Leaving it takes a press-and-hold. The network keeps running with the
  screen off either way; the screen only stays on so the codes can be seen.
- **The Android host's own screens are translated**: the share screen, join codes, display mode and
  Emergency reset now follow the chosen language (all 15).
- **Emergency reset from the Android host's menu.** The last item in the menu, in red, opens one screen
  that explains what will be erased and asks you to press and hold for three seconds: quick when it
  matters, hard to trigger by accident. It runs in the server on the phone itself (no admin login needed,
  and it works whether or not the remote kill switch is enabled), and connected phones clear their copy.
- **Direct Messages lists your conversations, not everyone.** The sidebar shows only people you've
  actually messaged (newest first, plus the assistant if there is one), and **New message** opens a
  searchable picker of everyone on the node. A new `GET /api/dms` inbox tells each device about DMs that
  arrived while it was away, which now show an unread dot instead of going unnoticed.
- **Invite: Copy link**, and a line explaining how to join.
- **Search** opens with `/search?q=…`, highlights the matched words, shows results as plain text (no
  `**Markdown**`), starts a long result near the match, and explains itself before the first search.
- **Choose light or dark.** Settings → Appearance offers System (follow the device, the default), Light or
  Dark, as tiles that preview each palette. The choice applies at once, is remembered in that browser, and
  follows across open tabs. The browser's top bar colour follows it, and inside the Android host the native
  top bar and status bar switch to match.
- **More reactions, and any emoji.** The actions sheet now offers 15 reactions in three rows of five
  (👍 👎 ❤️ 🙏 🤞 / 😂 😊 😮 😢 😩 / 😠 😐 🤔 🎉 ✅), and the desktop hover toolbar has 👍 👎 ❤️ 😂 ✅ plus a
  smiley button that opens the full set. A "+" tile under the grid opens a field for any emoji from the
  device keyboard (or pasted); the last four picks are remembered on that device, one tap away, and are
  cleared by a wipe. The server now accepts only a single emoji as a new reaction (`reaction_invalid`);
  an older reaction stored before this can still be removed.

### Security
- **The live-updates WebSocket refuses a page served from another port of the same computer**, which
  could otherwise ride a member's cookie (cookies ignore ports); the page's origin must match the host and
  the port it was addressed to, or the advertised client port. A refused upgrade is now closed properly
  instead of staying open until the node restarts.
- **Emergency Reset on an unencrypted network writes the deletion into the database file itself** before
  the reset is marked finished, so a power cut straight afterwards can no longer bring the old messages
  back out of the write-ahead log.
- **A failed Emergency Reset on a plaintext or ephemeral-key node is finished by the next boot.** The wipe
  journal is written before anything is touched, so a reset that fails partway (full disk, I/O error) no
  longer leaves a restart serving the old messages; the next boot deletes the database and media and
  restores the admin config before serving, and the 503 says exactly what a restart will do.
- **Sync hardening against a hostile peer.** One record too large to download is remembered as refused
  once isolated, so it can no longer make every round repeat the same downloads and stall everything
  after it. A peer may introduce at most 200 new channels a round and 2 000 in all. A peer may author new
  posts only as users that sync introduced or as a brand-new author, never as a user created on this node
  (their owner-only channels included). Timestamps on imported messages are clamped to this node's clock
  plus five minutes, so a far-future stamp cannot sort first forever or escape retention. Attachment
  downloads from an encrypted peer are capped at 2 MB each and count toward the round's budget. The
  request that links two nodes no longer carries this node's own sync token. When a peer without a pinned
  key answers a later handshake with a different key, its public data is still pulled but the sync token
  is withheld, a warning is logged once, and the admin sync panel marks the peer.
- **Mesh:** a re-offered copy of sealed mail can raise the hop budget only of mail this node carries,
  never of mail a local user sealed here; a contact card whose keys have the wrong length is refused when
  added and ignored if an older build stored one, so sending to it answers 404 instead of a server error.
- **Fenced code blocks can no longer carry a CSS class**, so a post cannot dress itself up as one of the
  app's own notices or buttons.
- **The web app's service worker answers every page load from one request for the app shell**, so a
  conversation id or search term in the address never reaches the network or the browser's cache on a
  reload; message search keeps the term out of the address altogether.
- **Android host: cleartext HTTP is allowed only to the embedded server on the phone itself** (localhost),
  through an Android network security config, instead of app-wide.
- **The terminal UI's "same name as someone else" warning sees through zero-width characters, lookalike
  letters and case**, so a copied name cannot slip past it; control and invisible characters never reach
  the terminal. A new kiosk password needs at least 8 characters and is hashed at a higher cost; passwords
  saved by earlier versions still unlock.
- **Dependency bumps:** `shell-quote` to 1.12.0 (clears the one critical advisory `pnpm audit` reported; it
  only ever ran in development tooling) and `@fastify/websocket` to 11.3.4 (socket errors during the
  upgrade hooks are handled). The three advisories left are build-time tools with no patched release.
- **The node serves only requests addressed to it**: by IP address, `localhost`, a `.local` name, or the
  join address it advertises. Anything else is refused with 421, which shuts out DNS-rebinding pages on
  internet-connected networks. A node reached by some other DNS name (a sync peer URL, a reverse proxy)
  needs that name advertised with `LOAM_JOIN_HOST` or the terminal screen's join address.
- **The live-updates WebSocket refuses a page from another origin**, even one presenting a valid session
  cookie.
- **A channel owner could set their channel's retention above the network-wide limit.** Only an admin can
  set a channel's retention now, and a channel setting can only make messages expire sooner than the
  network setting, never later.
- **Creating a private channel no longer reveals that another private channel of the same name exists.**
  Private channel ids always carry a random suffix; public channels keep their clean names.
- **The data directory is private to the node's user.** It is created 0700, the database files are kept
  0600, and config and wipe-journal writes keep an existing file's mode or default to 0600, so other
  accounts on a shared computer can no longer read messages or raw session tokens.
- **The panic route no longer gives itself away through rate-limit headers.** `/api/panic` answers every
  failure with a 404 so a prober can't tell it exists, but the old rate limiter added
  `x-ratelimit-limit` (and `retry-after` once tripped) to its responses and to no unknown path. The
  server's own limiter sends no `x-ratelimit-*` headers.
- **Encrypted replies are tied to the request that asked for them** (`optional` mode, which most nodes run):
  each reply is sealed under its request's sequence number and its HTTP status, and the web app refuses a
  reply whose encryption was stripped mid-session (only the node's own "session unknown", "wrong address"
  and "resetting" answers get through, without their text). So someone on the network can no longer replay an
  old reply or swap in a forged one. Older clients still open across the upgrade are answered as before.
- **A flood of new encrypted sessions can no longer push people off the node.** One device identity holds at
  most 16 sessions (its tabs share one), making room by dropping sessions no open tab is using and otherwise
  refusing, never by closing an open tab; when the table is full the busiest source loses its oldest
  unused session first.
- **On IPv6 networks, one device can no longer use up the admin-claim, panic or connection limits for
  everyone else on the network**: those limits count each address, with a looser bound per network so
  cycling addresses still doesn't buy unlimited guesses.
- **Secret comparison is correct at any length** (it compared only the first 256 bytes; every secret LOAM
  checks is shorter, so nothing was exposed).
- **The admin claim answer no longer includes the raw user record**, which showed a shadow-banned claimer
  that they were shadow-banned.
- **A message's attachments are the server's record of the upload**, not what the client said about them,
  so deleting a message always removes the right file.
- **Emergency Reset on an unencrypted node leaves no deleted text in the database file**: plaintext
  databases now overwrite deleted rows, and the reset compacts the file, which also clears rows deleted
  before this release. It is still not secure erasure on flash storage; encrypt the database for that.
- **Mesh mail gives away less about where it was sent from.** A new message starts with a hop budget picked
  at random from the top three, its stated send time moves back by up to an hour, and a relay dates carried
  mail by when it took it in (so a relay with message retention no longer deletes fresh mail on arrival).
  Where a message first appears still points to its origin; docs/16 §9 says what is and isn't hidden.
- **Mesh: a recipient refuses mail whose sender key isn't a proper 32-byte key**, so the inner signature
  can't be read with a different split between key and message. Mail from every released version still
  opens.
- **Vendored, checksum-pinned SQLite wrapper packages for the Android build**, so building the APK no
  longer downloads anything from the npm registry. Release APKs get a `.sha256` file and a build provenance
  attestation, CI runs `pnpm audit`, and pnpm refuses package versions less than a day old.

### Fixed
- **Unused identities are kept while they have an open report, and for a week while they wait in a
  greeter's queue**; someone let in from the queue is kept for a day from when they were let in, not from
  when they first asked. Removing an identity also removes its pending channel join requests and mesh
  contacts. The greeter's queue shows how long each person has been waiting.
- **An ephemeral-key node stops at start-up if it cannot save its marker file** instead of creating a
  database the next start would refuse; a node started without an ephemeral key refuses to start if it
  cannot remove a leftover marker, so a later ephemeral start can never mistake its database for leftovers.
- **An Emergency Reset that could not even be recorded now says so everywhere**: the web app, the Android
  host's reset screen and the terminal UI tell you to restart and run the reset again, instead of promising
  that a restart finishes it. The response carries a `journaled` flag the hosts read.
- **Android host: both screen orientations are declared optional again.** Google's code scanner, included
  through expo-camera, adds a portrait-locked activity that made the built app require a portrait screen,
  so Play could have hidden LOAM from landscape-only devices such as Android laptops.
- **Android host: the hotspot asks only for what each Android version needs.** On Android 13 and later it
  asks for Nearby Wi-Fi devices alone, and the app no longer declares location there at all (the manifest
  caps it at Android 12). On Android 12 it asks for coarse and fine location together (Android 12 ignored
  the fine-only request, so a fresh install there could never start the hotspot). Not yet tried on a real
  Android 12 or 13+ phone.
- **Sync: a message in a channel the per-round channel cap put off is fetched again** by the round that
  imports its channel, instead of being remembered as refused for an hour.
- **Threads survive the offline cache cap.** The root of a cached reply is kept with it however old it is
  (and goes once all its replies have), so a cached thread always opens offline.
- **Every error the node answers with now has a code**, so the web app shows it in the chosen language
  instead of English: timeouts, join requests, channel deletion, reports, mesh contacts, attachment size,
  "this network is resetting" and the encrypted-connection refusals. A test keeps it that way.
- **Replies can only answer a channel post**, not another reply; deleting a post also removes any older
  nested replies under it.
- **Reporting the same message or person twice updates the earlier report** instead of filing another; one
  person may have 20 open reports and a node 2 000, the moderation queue is read in one pass, and a report
  about a very long message is cut with a note instead of vanishing from the queue.
- **An error inside an Emergency Reset locks the node and tells clients to purge** instead of answering with
  a server error and leaving the node half wiped. A reset on a phone-hosted encrypted network turns
  node-to-node sync off when its token had to be left behind, and says so at the next start.
- **`loamnet --encrypt` takes the journaled Emergency Reset** (the one that resumes after an interrupted
  wipe); a node started with a key and no declared key mode is treated as passphrase mode.
- **Identities that were never used are removed after a day**: created but never agreed to the rules, never
  wrote or received a message, never connected. Stray requests no longer leave ghosts on the People list.
- **The node's bootstrap and config replies are validated** against the shared schema; a reply of the wrong
  shape shows a readable error instead of a blank boot.
- **A newer build upgrading the local database in one tab no longer stops the other open tabs** reading
  and writing; only a wipe does. The local message cache keeps the newest 500 messages per conversation and
  drops conversations the node no longer lists at start-up.
- **The service worker precaches every file of the build**, so a device that joined once can open the app
  offline from the first visit in any language; each build gets its own cache, so a new version refreshes
  the icons and manifest and drops old bundles. The installed app's colour matches the page background.
- **A "link another node" QR opened in a browser keeps the network's key** and explains that the code was
  for another node.
- **Terminal UI "Open as admin" works on Windows** (its arguments are passed verbatim), reports success only
  when the opener exits cleanly, and always shows the admin link beside the message.
- **`loamnet`** accepts `--port=4000` as well as `--port 4000`, refuses an unknown option or a stray
  argument with one line instead of ignoring it, and in plain mode prints the server log only as
  `[warn]` and `[error]` lines (everything with `--verbose`), never as raw JSON with the hostname. The
  printed join QR is drawn black on white on a colour terminal so it scans on dark themes, and `pnpm dev`
  prints the QR with the node's key.
- **Android host: every native screen follows the chosen language.** The starting and recovery screens,
  the Encryption settings screen, the on-device model manager, the hotspot and setup failure reasons, the
  notification permission prompt and the "LOAM is hosting" notification itself are translated into all 15
  languages. The recovery text for a missing encryption module had lost its first word ("Nothing was stored
  unencrypted"); fixed. The hosting notification uses a monochrome status-bar icon instead of the launcher
  icon.
- **Smaller server fixes:** a file name with a broken character can no longer fail its download; editing a
  message in a private channel you are not in gets the same answer as an unknown message; approving a join
  request across a block is refused like an invite; the assistant bot and system records cannot be given
  roles or moderated; banned and pending members are left off a private channel's member list; direct
  messages to a mesh sender record or to a disabled assistant are refused; the assistant shows one plain
  sentence when its backend fails instead of the backend's error text.
- **A device wiped from Settings can rejoin by scanning the join QR again.** The "Device wiped" screen
  used to stay until site data was cleared by hand, because the app read the join key after it had
  already been stripped from the address. The Android host's own screen recovers the same way.
- **The admin channel editor encodes the channel id in its request URL**, and the admin Mesh panel no
  longer shows an internal document reference.
- **An ephemeral-key node could not start a second time.** A desktop node run with
  `LOAM_DB_KEY=ephemeral`, or a `loamnet --encrypt` service with no passphrase and no terminal, minted a
  fresh key every boot but kept the previous boot's database, so the second start failed with "wrong or
  lost key". The server now removes the dead network's database and uploaded media itself, as the
  Android host already did, and refuses to start over a persistent database it would otherwise destroy,
  with a message that names the data directory and the way out.
- **`loamnet` on Node.js 18 or 20 said "wrong or lost database key".** It now says which Node.js it
  needs, before anything else runs.
- **The bare server advertised port 3000 in the join QR** whatever `PORT` was. The join address now
  follows `PORT` unless `CLIENT_PORT` is set.
- **On Android 13 and newer, the first launch no longer asks for the hosting notification and the
  hotspot's location permission at the same time**, which could cancel one of them and leave the hotspot
  unstarted. A permission request Android never answers now times out after a minute with a message to
  reopen the share screen, instead of blocking every later hotspot start.
- **Emergency Reset from the host menu removes the last file handed to the share sheet** before LOAM
  closes, instead of leaving it in the cache until the next launch.
- **The privacy page on loamnet.com lists the Camera permission** the app asks for on the link-code step,
  as the policy inside the app already did.
- **`config.example.json`** ships with the assistant off and no longer suggests a prompt "for a younger
  user" on an 18+ product.
- **Messages crashed the app on older Android WebViews.** Checking whether a message is only emoji (to
  show it large) relied on `Intl.Segmenter`, which arrived in Chrome 87 and Safari 14.1, but LOAM supports
  WebViews back to about Chrome 80. Without it, any message with text threw and the app fell to its error
  screen. Text is now split with a fallback that keeps emoji sequences (skin tones, families, flags) whole.
- **The privacy policy, README and website overstated connection encryption.** Joining by the code
  encrypts messages, but on a network that doesn't require encryption (the default) pictures and files
  are downloaded unencrypted. They now say so, and that the website also counts copies of the
  `npx loamnet` command.
- **Joining by QR code lost the network's key.** The web app's first redirect (`/` to `/channels`) dropped
  the `#k=` part of the link before it was read. On a network that only accepts encrypted connections,
  everyone who scanned the code was told to scan it; elsewhere they connected without the protection the
  code is meant to give. The key is now read before anything touches the address. This had been the case
  since transport encryption arrived.
- **The host phone could land in the queue of its own new network**, and an approved newcomer could fall
  back into it. Asking the node "who am I?" again on an already-encrypted connection answered with the
  person as they were when the connection was set up, so an admin claim or an approval made since was
  undone on the next refresh (and the host's page retried its claim until it was rate-limited). The node
  now answers with the person as they are.
- **After an Emergency reset the host app could get stuck** ("Couldn't finish starting LOAM", recoverable
  only by clearing the app's data) or quietly restart an empty network. LOAM now closes completely once
  everything is erased, and opens on the setup screens next time. If something couldn't be erased, the
  reset screen says so and stays open instead.
- **`npx loamnet` no longer crashes when port 3000 is taken.** With no port chosen it moves to the next
  free one (3000–3019) and says so; an explicit `--port` / `$PORT` that is taken exits with a short
  message instead of a stack trace. A port counts as free only if loopback is free too, so
  `http://localhost:<port>` can't open another program.
- **No more `prebuild-install` deprecation warning on install.** The CLI's optional SQLCipher driver is
  now v13, which ships its binaries in the package and runs no install script. Encrypted databases open
  unchanged. **The CLI now needs Node 22.14+ (or 23.6+)**: the driver uses Node-API 10, and on an older
  Node it crashed the process when loaded; `loam --encrypt` there now says to upgrade. The package is
  ~9.5 MB larger, and 32-bit ARM (older Raspberry Pi OS) has no prebuilt binary, so `--encrypt` there
  needs a `node-gyp` build (the error says how). An unencrypted node never loads the driver.
- **Windows: saving the config and the reset journal works.** Every durable write on a Windows `loamnet`
  host failed (Windows can't flush a read-only file handle or a folder), so an Emergency Reset would have
  locked the node. The rename itself is best-effort on Windows. Not yet tried on a real Windows machine.
- **Turning public channels off no longer freezes private channels.**
- **Rate-limit refusals carry a code** (`rate_limited`), so the web app shows them in the network's language.
- **The radio courier hands over every queued mesh message in turn** instead of the same oldest 200.
- **Android host: errors appear in the chosen language**: hotspot, model download and manager, database
  encryption and reset errors were still English. Arabic, Persian, Dari, Pashto and Urdu now read right to
  left and align right on the host's own screens.
- **Translations checked** for every string added in the last two releases, in all 14 languages besides
  English: terms now match the rest of each language (Emergency Reset, peer, mesh card and others), and the
  host app's Portuguese is Brazilian throughout, like the web app's.

### Changed
- **Deleting a message, handing over a private channel and leaving one use the app's own confirmation
  dialog** instead of the browser's confirm box. Screen readers hear new messages arriving in the open
  conversation, one announcement per burst, and dialogs no longer tab onto hidden controls. The admin
  bootstrap choices read as plain words ("First person to join", "One-time setup code", "Passphrase", "This
  device (the host)", "Nobody").
- **One place for everything a message offers.** The three-dot button beside a message opens the same
  actions sheet as tapping its time (the full reaction grid, then reply, copy, edit, delete and report)
  instead of a shorter menu; the separate smiley button is gone.
- **One licence: AGPL-3.0-only everywhere.** The MIT file in the Android app directory is gone (the
  About screen already said AGPL), every workspace manifest names the licence, and the notice at the end
  of LICENSE no longer offers "any later version".
- **SECURITY.md** speaks with one voice, says that the reviews it lists are run with AI models and
  re-verified against the source, and no longer calls the unfinished on-device verification "the current
  release gate".
- **Asking for a feature.** The README, website, privacy policy, Settings and the host app's About screen
  invite feature requests as well as problem reports.
- **Docs refreshed.** docs/04 describes Display mode instead of the two switches it replaced; docs/05 and
  docs/29 say they are not the shipped design; docs/14 has the real package size, the Node floor and the
  terminal screen; the `loamnet` README no longer promises an installable offline PWA on a plain-HTTP
  address.
- **`loamnet` no longer makes the first person to open a new network its admin.** As on the Android
  host, admin comes from the host's own screen: `o` in the terminal view, the People screen, or (without a
  terminal) a one-time admin link kept in `admin-link.txt` in the data folder while nobody is admin. The `admin.bootstrap` setting no longer
  applies to a node run with `loamnet`.
- **`loam` without a terminal, or with `--plain`, prints no line per request** (`--verbose` brings them
  back), so its QR code stays visible.
- **Setup:** "Community" comes first, each kind of network has an icon, and choosing one moves straight on.
  The screen saying a private network "was erased" is gone: setup just starts again.
- **A clearer Android host menu**, grouped with proper icons: Invite people; Encryption and AI assistant;
  Network rules, Privacy policy and About LOAM; then Emergency reset, set apart in red, now on every
  network (and still at the bottom of Encryption settings). The top bar shows whether anyone is connected,
  and a tap opens the join codes.
- **The logo is back to the darker orange**, a touch more saturated, and the interface accent matches it.
- **LOAM now lives at github.com/MagicZebraLtd/loam**, copyright Magic Zebra Ltd. Donations go through
  [Ko-fi](https://ko-fi.com/magiczebra), linked from the website and README only: the app has no payments.
- **The privacy policy is served by the network itself** (`/privacy`), so it reads offline and the app
  never sends anyone to a website for it.
- **Storage encryption:** unencrypted storage is now the last option, labelled as for testing, and asks
  for confirmation. A network set up with "Choose every setting myself" is encrypted by default.
- **New website.** A redesigned loamnet.com with real screenshots of the web app (light and dark) and the
  Android app, a quick start for Android and for `npx loamnet`, and new fonts (Bricolage Grotesque and
  Inter, self-hosted), and a "What about iPhone?" section: iPhones join from Safari, but iOS doesn't let an
  app start a hotspot or keep a server running, so a Mac (`npx loamnet`) is the way to host for iPhone
  people. The footer's analytics note now matches the privacy policy: visits are counted without cookies
  or profiles, and PostHog does see your IP address.
- **README and operator's guide rewritten** for how LOAM works today: the Android setup screens,
  `npx loamnet` on Mac, Linux, Windows or a Pi, joining from any browser, invite and link codes, and
  where Emergency reset lives.
- **Plainer punctuation everywhere.** Every em-dash is gone from the interface in all 16 languages, the
  Android host app, the server's user-facing messages, the `loam` CLI and the website, rewritten as full
  stops, colons or commas. A test keeps the translations dash-free.
- **Android host: no more blank bands.** The page no longer pads for the status and navigation bars
  inside the host app, which already keeps clear of them.
- **Tidier conversations.** On wide screens the conversation keeps a centred reading column (your own
  messages no longer sit at the far edge); wrapped bubbles shrink to their text; the hover toolbar sits
  beside the bubble when there's room and never covers the author's name; the bubble's tighter "tail"
  corner is now at the top of a group, by the avatar; the composer's corners now follow its round send
  button.
- **Less noise.** No raw user ids in the DM header, the sidebar footer, Settings or the join-approval list
  (moderators still see them in the People list); an empty DM says "Say hello";
  desktop opens your last conversation (or the first channel) instead of an empty pane; the join-QR note in
  Settings is plain language.
- **Avatar colours are more distinct.** Base colours come from ten well-separated hues (yellow stays
  yellow instead of turning olive), so fewer people look alike.
- **No console error on load**: the client no longer trips its own Content-Security-Policy.
- **Copy buttons work over plain HTTP**: "Copy link" on the node link and the mesh contact card now use the
  same fallback as "Copy text", which LOAM's usual LAN setup needs.
- **Fewer server dependencies.** Rate limiting (`rate-limit.ts`) and serving the web client
  (`static-files.ts`) are now LOAM's own code, replacing `@fastify/rate-limit` and `@fastify/static` and
  about ten transitive packages; the CLI bundle drops from 3.19 MB to 2.83 MB. Behaviour is unchanged
  apart from no Range support for client files and never serving dotfiles.
- **Android host: Expo SDK 57 patch updates** (expo 57.0.26, React Native 0.86.3). `pnpm audit --prod`
  goes from 29 findings to 1: a moderate `decode-uri-component` advisory under expo-router with no reachable path in LOAM, whose fix is an ESM-only release expo-router can't load.
- CI now installs the packed `loamnet` tarball and drives the installed CLI (`pnpm smoke:cli`).
- **The web app loads the admin area, the mesh screen and the privacy policy only when opened**, so the
  main download drops from 507 kB to 465 kB. All of it is still saved for offline use.
- **Android host: unused Expo template packages and files are gone**, and there is no web build of the host
  app any more.
- **Removed the flat-JSON importer** for data from before LOAM used SQLite. No released version wrote those
  files, and a stray `users.json` in the data folder could stop a node from starting.
- **Server tests are organised by subject** instead of one 12,000-line file and files named after review
  dates, and the test files are now type-checked in CI. Code comments no longer carry review ticket numbers;
  `docs/audit-history.md` records the reviews instead. The docs gained status lines, the roadmap is written
  for readers outside the project, and HTTPS reverse proxies are documented as unsupported (docs/12).

## [0.5.0] - 2026-09-28

The pre-release review release: fixes from two full-codebase reviews (2026-09-04, 2026-09-25) and an
external one (2026-08-15), the server split, per-user blocking, Play Store groundwork, a Wi-Fi hosting
mode for the Android host, and a redesigned client.

### Security
- **Key pinning is fail-closed.** A QR-joined client can no longer fall back to plaintext on an
  `optional` node when its handshake fails, and refuses plaintext fetches/sockets outright. A node whose
  key changed (Emergency Reset, stale poster) shows a "scan the current join QR" gate instead of looping.
  A join link carrying a *different* key never quietly replaces the pin: while the pinned key still
  works the link is ignored, and once the node's key has really changed the client asks (showing both
  fingerprints) and accepts only the key the node itself reports. The Android host's own screen is handed
  the node's key by the launcher, so a node with an ephemeral database key (a new transport key every boot)
  no longer shows the host a rescan screen on every launch. On a pinned session the client refuses an unsealed tunnel reply (an on-path attacker
  could otherwise forge one, e.g. a mesh contact card). The invite QR a client shows carries the node key
  only from its own QR-verified session, and join-key fragments are stripped from links in messages.
- **Plaintext transport can't be configured any more.** `security.transportEncryption: "off"` is refused
  by the admin API; an `off` left in `config.json` or the database is read as `optional`, with a warning.
  Developer Mode (`LOAM_DEV_MODE`, never in production) is the only plaintext path.
- **Encrypted databases fail closed.** If the SQLCipher driver won't load, an encrypted Android node now
  stops on a lock screen (Retry, or a confirmed "Start without encryption") instead of silently running on
  plaintext SQLite; the `loam` CLI checks the driver before it starts, and the server locks with the same
  error when a keyed open fails for lack of the driver. After every keyed open the server refuses a
  database file that is still plaintext, and a keyed open that fails on a new node no longer leaves a
  plaintext file behind.
- **CLI passphrases stay out of `ps` and shell history.** Bare `loam --encrypt` takes `$LOAM_DB_KEY` or
  prompts without echo; `--encrypt <passphrase>` still works but warns.
- **Android host.** The host phone's own screen claims admin with a per-boot token (`hostDevice`), so no
  LAN device can take the first-user admin grant while the node boots. Passphrase mode asks for the
  passphrase at every start and never stores it. Android 12+ device-to-device transfer no longer copies
  the database, media or config to a new phone. The loopback mesh bridge requires the launcher's token on
  every host (a desktop/Pi node has no bridge).
- **Logs don't undo the tunnel.** Requests re-dispatched inside the encrypted tunnel are no longer
  request-logged (that printed the hidden path and query), and query strings are stripped from every
  logged URL. Fastify's own "reply was already sent" warnings, which printed the raw URL, now omit it. Unexpected server errors return a generic body; details go to the log only.
- **Server hardening.** Uploaded avatar ids are validated (a crafted id could reach outside the avatar
  directory); the assistant bot id must be an `llm.*` id and can't be pointed at a person's account;
  record ids are capped at 128 characters; session ids are longer (64-bit, minted collision-free) and
  session tokens 256-bit; admin-claim and panic attempt limits also count requests made through the
  tunnel; inbound WebSocket frames are capped at 16 KiB.
- **Upgrade quarantine.** A stored row from 0.4 that fails the tighter bounds and can't be safely repaired
  is quarantined at boot: not loaded, left on disk untouched, and its id refused everywhere. A sync peer, a
  new channel, the default channels or a new session can't take that id, and a peer can't re-supply the
  message or user. Messages under a quarantined channel, and replies and reactions under a quarantined
  message, are quarantined too. Previously the row was only skipped: a private channel with one over-long
  member id disappeared, and a peer's public channel with the same name was then written over it, exposing
  its retained messages. A boot warning gives the counts; Emergency Reset removes the rows, and retention
  (`retention.messageTtlMs` or a channel TTL) deletes quarantined messages once they expire. An open report
  0.4 wrote about a peer message with an over-long id is skipped the same way; it used to make every boot of
  an upgraded node fail.
- **Node-to-node sync.** A peer can no longer edit a post a local user wrote, re-type a private message
  into a public channel, bind a local or pending attachment to its own message, undo a moderator's
  removal, or add new replies or reactions under a post a moderator removed here. Only the authors of
  accepted messages are imported, and mesh ids, the whole `llm.*` assistant namespace and non-human
  (bot/system) author records are refused. A peer that answers every batch with junk can no longer make
  a round issue thousands of requests: splitting a bad batch has a per-round request and byte budget,
  after which the peer fails the round, and too-large answers shrink later batches. An import is checked
  again right before it lands, after its attachments download, so a moderator removal, delete, archive or
  parent removal made meanwhile wins, and the files a discarded import wrote are deleted; the
  missing-attachment retry no longer fetches a file back for a message that no longer lists it. Only
  records the puller asked for, on the list it asked for them on, are imported. The
  sync token is never sent on a plaintext pull, a `required` node refuses plaintext pulls, and a peer that
  negotiated encryption is never silently downgraded.
- **Mesh.** Replay protection keys on the sealed content (ciphertext, routing tag and expiry), only the
  canonical encoding is accepted, and a forged hop budget or metadata can no longer shadow genuine mail.
  A node now fetches every eligible sealed offer rather than only its own mail, so the serving peer can't
  learn which node a recipient uses (docs/16 states the remaining leak). Every sealed offer a node has
  fetched or received is remembered durably, whatever became of it, for longer than any tombstone it can
  leave (the 30-day tombstone horizon plus the 7-day TTL maximum and two days' slack), and skipped on
  every digest list, so a restart, a config save, switching relaying on, re-listing the ids as public
  messages or re-advertising them with a later TTL no longer makes it re-fetch only the blobs it dropped
  (which told the serving peer which ones it had delivered). Sealed offers must carry a `seal_` id and
  public records may not, so the two lists never share an id. Each source may fill at most 50 000 of the
  record's 200 000 entries; past that the node stops pulling new sealed offers from that source, and blobs
  arriving over the radio bridge obey the same bounds. The record also keeps each mail's replay key, so the
  same mail re-offered under new ids isn't carried either. A sync round imports the sealed mail it fetched
  only after its last request, so request timing can't show which batches held local mail, and the radio
  bridge's answer and the courier's re-advertising no longer depend on whether a blob was delivered. A node with relaying off and no local mesh identity pulls
  no sealed mail, and `mesh.maxSealedPullPerRound` (default 80) caps sealed pulls per round for metered
  links. Mesh identities are only minted for local users, and rows an older build minted for synced users
  are deleted at boot; a database upgraded from 0.4.0 first has its peer-imported users identified and
  marked, and the `mesh.*` records it imported from peers removed.
- **Emergency Reset.** An upload landing mid-reset can no longer restore the pre-reset user or leave a
  file behind; start-fresh recovery snapshots are swept too; an assistant reply streaming across a reset
  is abandoned; a device that was offline during the reset clears its local copy when it next connects.
  On a fixed-key node without the Android launcher, the full config is re-persisted after the reset.
- **One content-mutation policy** (from the external review): removed private-channel members, timed-out
  users, archived channels and posting-policy lockdowns can no longer be bypassed through edit, delete or
  reaction paths; moderator timeouts also cover channel creation, metadata edits, roster growth, profile
  edits, avatar uploads and mesh sends; rate limits apply inside the encrypted tunnel. `SECURITY.md`
  corrected.

### Fixed
- **The hotspot join QR pointed at an address no joiner could reach.** Android gives a local-only hotspot
  a *random* address on every start (in 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 — never the
  `192.168.49.1` the QR assumed, which is a Wi-Fi Direct address), so scanning Step 2 on a joining phone
  gave `ERR_ADDRESS_UNREACHABLE`. The Android host now discovers the hotspot's own address (the interface
  that appeared with the hotspot and isn't one of the phone's own networks) and puts that in the QR. Until
  it is found, Step 2 says so instead of showing a guess; if it can't be found, Step 2 explains how to read
  the address from the joining phone's Wi-Fi details (Gateway) and lists the host's addresses. The
  discovery cross-checks the phone's own Wi-Fi address, merges the launcher's view of the interfaces, and
  once a phone has actually connected, the interface it came in on is confirmed and Step 2 shows
  "N phones connected" — the proof that the whole join path works.
- **Dead connections are noticed.** The server sends a heartbeat on every WebSocket; a client that stops
  hearing it reconnects, and re-checks when the device comes back online or the page becomes visible. A
  check that runs late because the page was frozen waits briefly for queued frames instead of dropping a
  healthy connection.
- When a node resets this browser's identity, other open tabs of LOAM drop the old identity's messages and
  reload too. Tunnelled images still on screen after a wipe or identity change load again instead of
  showing broken.
- **Android keeps hosting with the screen off**: the foreground service is re-asserted whenever the app
  returns to the foreground (a start from the background can be refused), and the notification permission
  is requested so the "LOAM is hosting" notice shows on Android 13+. A system-stopped hotspot (tethering,
  Wi-Fi toggle) is reflected on the share screen and restarts on reopen.
- Drafts, pending attachments, report dialogs and scroll position no longer follow you into the next
  conversation, and a report dialog stays bound to the user it was opened for.
- A message deleted or edited while its conversation was loading is no longer resurrected or reverted;
  unread markers use the server's timestamps rather than the device clock.
- Moderator timeouts are a duration applied on the node's clock (capped at 7 days), so a moderator's
  device clock can't set a years-long or already-expired timeout.
- A message removed by a moderator can't be edited by its author or take new replies or reactions.
- Assistant: a reply interrupted by a crash is finalized on restart, a moderator removal stops a reply
  mid-stream, replies are limited to one per user and two at a time per node, and an admin save no
  longer freezes the Android host's model switching. Stopping an on-device reply keeps its slot until the
  phone's model finishes, so a new request can't start a second generation beside it. An admin's own on-device model change is saved to
  `config.json` when that file holds the on-device settings (the Android host, or any node after an
  Emergency Reset), so a restart no longer undoes it.
- Claiming admin on a node that requires join approval now leaves the claimer approved.
- The orphaned-attachment sweep can no longer delete a file an in-flight upload is about to use.
- Non-image files sync between nodes over encrypted sync, up to the 1 MiB file limit.
- The legacy demo users (`user.1234`/`user.5678`) and their messages are removed from older databases.
- Android: overlapping encryption/model requests to the embedded server no longer time each other out.
- Android build: the plain SQLite driver is now vendored in the repo, after an upstream re-upload broke
  the pinned download.
- Large encrypted requests (up to 4 MiB) no longer block the server for tens of milliseconds while being
  decoded.
- Earlier review fixes: a transparent re-handshake closes the socket sealed under the old key; a wipe also
  forgets the cached node key, image URLs and rendered-message cache; a non-member editing a private
  channel gets the same 404 as elsewhere; sync honours a channel's posting policy and the node's flags;
  typing signals respect posting policy; sealed mail is dropped when DMs are off; unreferenced avatars are
  cleaned up at boot; the `npx loamnet` join QR carries the node key; the 1 MB attachment limit is
  actually reachable.
- Search rejects a malformed query with a 400; a malformed link no longer crashes routing.
- Sync: offers refused under an old policy are fetched again right after an admin config save or a change
  to a channel's archived, posting or replies setting, instead of up to an hour later.
- `loam --encrypt`: an empty passphrase for an existing database is refused (it used to pick an ephemeral
  key that can never open it), a pasted passphrase and confirmation are no longer cut at the first line,
  and the missing-driver message says to reinstall `loamnet` rather than install the driver globally,
  where `loam` never looks.
- Android: the "Start without encryption" confirmation no longer tells an ephemeral-mode host that its old
  database stays on disk; it was already deleted.
- The Play listing no longer hides from landscape-only devices such as Chromebooks: the portrait screen is
  declared optional.
- An Emergency Reset journal whose saved config predates this release (`off` transport, an old bot id) is
  repaired like `config.json` instead of locking the node as corrupt, and a repaired stored config is
  written back once, so its warning doesn't repeat every boot.
- An assistant bot id replaced by the upgrade repair (or changed by an admin) no longer leaves the old bot
  on the member list as a dead contact; only the configured assistant is listed.
- A node upgraded from 0.4 boots even when its database or `config.json` holds values past the new
  bounds: a private channel's roster entry over 128 characters is dropped (it can't be a local user), an
  assistant model label over 120 characters is truncated, and any other stored user, channel or message
  that no longer validates is quarantined (see Security).

### Added
- **Wi-Fi hosting mode** on the Android host. The Share · Host screen opens with a Hotspot / Wi-Fi choice
  (remembered across launches; Hotspot stays the default). Wi-Fi mode hosts on the network the phone is
  already on: no hotspot, no location permission, and one join QR for everyone on that Wi-Fi. It advertises
  the phone's own Wi-Fi address; a VPN, mobile data or the phone's own tethering never reach the QR, and with
  Wi-Fi off there is no QR, only "connect this phone to a Wi-Fi network first". Guest, hotel and campus
  networks that keep devices apart are called out on the screen (docs/04 "Hosting modes"). Compiled and
  unit-tested; not yet verified on a physical phone.
- **Blocking.** Block someone from their DM header; unblock there or in Settings. Blocking stops DMs, DM
  reactions and typing both ways, stops either of you inviting the other into a private channel or handing
  them one, and hides the person's channel posts, replies and reactions on your device, search results
  included. They aren't told: a DM to someone who blocked them gets a generic "not available" answer that
  doesn't say why. The list is private to you, never synced, and cleared by Emergency Reset; the device keeps
  a copy so blocked people stay hidden when it starts offline.
- **Privacy policy** at [loamnet.com/privacy](https://loamnet.com/privacy), linked from the site footer,
  the client's Settings and the Android host menu.
- **Report this user** from a DM's header.
- Channel **Delete** (permanent, with its messages, reactions and files; sync never re-imports it).
- A download confirmation for on-device models, stating the size and warning about mobile or metered
  data.
- A dismissible error notice at the top of the screen, a "conversation not available" state, and a
  recoverable crash screen.
- `pnpm --filter app aab` builds an Android App Bundle for Google Play, and tag builds in CI produce it as
  the `loam-host-aab` workflow artifact (not attached to the Release); a themed (monochrome) app icon.
- Every one of the 14 non-English locales now covers every string, with a test that keeps it that way
  (machine-translated, pending native review).
- CI checks that all package versions agree; tag builds also check the tag and that `versionCode` is above
  every earlier release tag's. `vX.Y.Z-rc.N` and `vX.Y.Z-beta.N` tags build like releases (keystore, tests,
  the AAB) and are published as GitHub pre-releases. A stale generated Android project now fails the build
  instead of shipping old settings.

### Changed
- **The client is redesigned.** An earthy palette (linen in light mode, dark loam in dark, moss green for
  actions, a brighter brand orange) on the native font stack, one design system (`apps/client/DESIGN.md`),
  and the chat conventions people already know: bubbles with the time inside, consecutive messages grouped
  under one avatar, a hover toolbar on desktop and a long-press sheet on touch instead of a permanent row of
  icons, reaction chips, a pill composer, a conversation header whose title is never squeezed by buttons
  (Members, Report and Block live in a menu), settings, admin, people and search on a card layout,
  confirmations as proper dialogs, and "N new messages" toasts that coalesce per conversation. Renders on old
  Android WebViews (the build targets Chrome 80) and in the five right-to-left locales.
- **The on-screen keyboard no longer pushes the header off screen.** The client is a fixed frame sized to
  the visible viewport, so an open keyboard shrinks the layout instead of scrolling the page, and the
  message list stays on the newest message. The Android host shrinks its WebView for the keyboard as well.
- Android host: the native top bar, menus and share screen use the client's palette.
- **Archived channels are read-only but visible** (readable, searchable, listed with a badge; composing,
  actions and roster growth frozen). See the upgrade notes.
- Release signing: `pnpm --filter app aab` refuses to build without a release keystore, and a
  debug-signed APK build warns unless acknowledged with `--debug-signed`. CI actions are pinned to commit
  SHAs (Dependabot bumps them weekly), and the job that publishes releases is separate from the build.
- **DMs to banned or not-yet-approved members are refused** (`dm_unavailable`). They used to be accepted.
  It's the same generic answer a blocked sender gets.
- Android: Wi-Fi, location and Bluetooth are declared optional hardware (so Play doesn't filter out
  tablets and Chromebooks); unused template permissions are blocked; incoming `loam://` links only ever
  open the host screen.
- The server's 9.4k-line `app.ts` is split into a ~2k-line core and sibling modules (no behaviour change).
- README and the site no longer claim an installable offline app on the plain-`http` hotspot path.
- Dependencies: Vitest 5, Fastify 5.12, Zod 4.6, Vite 8.3, DOMPurify 3.4.15, and other minor updates.

### Upgrade notes
- Channels archived under the old semantics were *hidden*; they now reappear for their audience as
  read-only (archive was never an access control, but it was a visibility control). Use **Delete** for
  gone-for-good. Archiving no longer purges members' local caches; Delete does.
- A `config.json` with `"transportEncryption": "off"` now boots as `optional`; set `LOAM_DEV_MODE=1` (not
  in production) if you need plaintext for debugging.
- Existing session ids keep working; new ones are `user.` + 16 hex characters.
- Android host: an updated install keeps hosting in Hotspot mode as before; pick **Wi-Fi** on the Share
  screen to host on an existing network.

## [0.4.0] - 2026-08-08

The device-feedback release, and the first version published to npm as
[`loamnet`](https://www.npmjs.com/package/loamnet) (`npx loamnet` runs a node on a laptop/Pi). All
workspace versions aligned to 0.4.0 (Android `versionCode` 6).

### Fixed
- **Hotspot join QR pointed at an unreachable address** on phones with STA+AP concurrency (host on
  home WiFi *and* hotspot): the join URL now targets the hotspot gateway (`192.168.49.1`) while the
  LocalOnlyHotspot is running, and the real LAN address otherwise (`apps/app/src/lib/join-url.ts`).
- Settings screen: profile-edit controls now render only when the node allows them (no more
  greyed-out "disabled" noise); the "Open the admin area" button no longer renders as a one-word-
  per-line column.
- `docs/21` corrected: passphrase change is delete-and-start-fresh; in-place rekey is unbuilt.

### Changed
- Delivered the `docs/27` "PR 1" completeness arc (#109/#110): moderation **report loop** (private
  reports → mod queue → dismiss/delete/timeout/ban/escalate, honest tombstones, composer countdown),
  channel-metadata re-sync with per-peer provenance, general **@mentions**, per-channel retention
  TTL, lock/pin channels, **typing indicators**, private-channel **join requests**, non-image **file
  attachments** (1 MB), pinned-peer-key admin field, i18n en-fallback.
- Dependencies: jsdom 30, js-sha256 1.0, Node pin 24.15.0.

## [0.3.0] - 2026-07-31

Everything landed on `master` since 0.1.0 — 0.2.0 was an interim device-test build, and **0.3.0 is the
first release-signed build** (CI signs and attaches the APK to each tagged release). Verified on a
physical phone this cycle: the on-device LLM works, encryption persists, and the earlier crashes are
fixed. Also added an LLM DM-context bound, a 256KB sync-import body cap, and a docs / README / site
accuracy pass. The detail below is the full arc since 0.1.0.

### Security & privacy
- **Transport encryption (docs/08) — QR-bootstrapped app-layer session encryption over plain HTTP.**
  X25519 handshake (host static + ephemeral, forward-secret) + XChaCha20-Poly1305, keyed by the join
  QR's `#k=` fragment (out-of-band, MITM-resistant). Modes `off` / `optional` / `required`; the axis
  that now distinguishes the `open`/`standard`/`hardened` security profiles. A QR-pinned join can't be
  downgraded to plaintext by a tampered `/api/config`.
- **Transport v2 hardening** _(in review at 0.3.0; since shipped)_: per-session **anti-replay** (DTLS-style sliding
  window), a **path-hiding tunnel** in `required` mode (every request → opaque `POST
  /api/transport/tunnel`, so paths/queries/response bodies are all ciphertext), and **image
  encryption** (avatars/attachments fetched through the tunnel into `blob:` URLs). Reviewer's guide in
  `docs/18`.
- **Node-to-node sync transport encryption** _(in progress at 0.3.0; since shipped)_ — encrypts the pull-based sync channel and
  fixes a `required`-mode sync gap.
- At-rest SQLCipher encryption, kill switch / panic token, ephemeral message retention, per-IP
  anonymous-identity budget, shadow-ban / roles egress hardening, and bounded rate-limit maps.

### Messaging
- Public + **private channels** (membership, ownership transfer, targeted removal), threads, DMs,
  reactions, **image attachments**, message **search**, **location sharing** (opt-in, `geo:` link),
  and an optional local **LLM** (Ollama / on-device) chat contact.
- **Opportunistic mesh / DTN** (docs/16): sealed-sender `@loam/crypto`, self-certifying `mesh.` ids,
  contact-based secure addressing, bounded relay, group/broadcast fan-out. **Phase 3** native
  BLE/Wi-Fi-Aware transport _(in review at 0.3.0; since merged — still needs radio verification)_.

### Apps & platform
- Installable **Preact PWA** client; **Fastify** server (SQLite DAL, REST + WebSocket).
- **Android host app** (Expo): embedded Node server, `LocalOnlyHotspot`, QR join, background
  foreground-service hosting, kiosk mode, one-command APK build, release-signing scaffold.
- **i18n** across 15 locales; node-to-node **sync** (public data only, tombstones, optional bearer
  token); node **presence**; admin **security profiles**, moderation, and join-approval.

### Internal / quality
- `app.tsx` modularized from ~6100 → ~3300 lines: message render helpers → `lib/messages`, and
  `Avatar*`/`MessageComposer`/`MessageItem`/`Sidebar`/`ChannelMembersPanel`/`AdminView` (+ sub-panels)
  → `src/components/` with tests _(the AdminView split was in review at 0.3.0; since merged)_.
- O(N·M) → O(M) conversation render; cached Intl formatters + per-message markdown; in-order message
  merge. Deterministic crypto tamper test. Expanded package/server test coverage.
- User-facing copy softened from thriller/espionage framing toward calm utility language ("Kill
  switch" → "Emergency Reset" in the UI; code identifiers unchanged).

## [0.1.0] — pre-1.0 baseline

The first cohesive feature set: SQLite persistence behind a DAL, the `buildApp()` server factory with
admin bootstrap + config API, kill switch, ephemeral messages, the PWA client + test harness, the
Android host (embedded server + hotspot + QR join), at-rest encryption, private channels, search,
attachments, node-to-node sync, presence, roles/moderation, security profiles, and the mesh/DTN
foundation. See the git history and `docs/` for the full initiative-by-initiative record.
