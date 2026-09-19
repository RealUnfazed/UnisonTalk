// A 1:1 chat only shows up in someone's list once there's actually
// something to see: a message has been sent, or the chat is theirs to
// begin with (they created it — see `admin`, set for private chats too,
// not just groups, in chatController.createPrivateChat). Groups always
// show immediately — being added to one is itself a meaningful event,
// the same way it is in every mainstream chat app.
// `admin: { $exists: false }` covers chats created before this rule
// existed, so nothing that was already visible disappears.
//
// This is a "should this show in my list" rule, not an access-control
// one — controllers/chatController.getMessages deliberately does NOT use
// this; being a real participant is what authorizes reading messages.
function visibleToMe(userId) {
  return {
    $or: [{ isGroup: true }, { lastMessage: { $ne: null } }, { admin: userId }, { admin: { $exists: false } }],
  };
}

module.exports = { visibleToMe };
