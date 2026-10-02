const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      match: /^[a-zA-Z0-9_]+$/,
    },
    // A separate, freely-changeable identity shown throughout the UI.
    // `username` stays fixed (it's what search/mentions key off of);
    // this is purely cosmetic and defaults to null, meaning "just show
    // the username" — see avatarUrl() below and utils/serialize.js.
    displayName: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Not `required` at the schema level, because a Phasetime SSO signup
    // never sets one at all — see controllers/ssoController.js. Local
    // registration (controllers/authController.js) enforces its own
    // "password is required" check before ever calling User.create().
    password: {
      type: String,
      default: null,
    },
    // Set once a person signs in with (or links) Phasetime SSO —
    // see controllers/ssoController.js and README.md's "Phasetime SSO"
    // section. `sparse: true` lets any number of accounts have this
    // unset (null) without violating the uniqueness constraint; only
    // actual Phasetime IDs need to be unique.
    phasetimeId: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    // Server-relative path to an uploaded profile picture (see
    // controllers/userController.js), or null to fall back to the
    // generated ui-avatars.com avatar — see avatarUrl() below.
    avatar: {
      type: String,
      default: null,
    },
    // Base64-encoded SPKI export of the user's ECDH (P-256) public key.
    // Only ever needed for Secret Chats (see models/Chat.js) — Cloud
    // Chats don't use client-side encryption at all, so most accounts
    // may never populate this. Safe to be fully public: anyone can use it
    // to encrypt something to this user, but it reveals nothing about
    // their private key, which never leaves their device.
    publicKey: {
      type: String,
      default: null,
    },
    // Deliberately simple, flattened privacy controls — not Telegram's
    // full "Everyone / My Contacts / Nobody" model, since this app has no
    // contacts list to key a middle tier off of, and not reciprocal
    // (hiding your own last seen doesn't also hide others' from you,
    // the way Telegram's does) — see README's "Profile & group
    // customization" section for the reasoning and what's deferred.
    privacy: {
      // Controls BOTH online status and the last-seen timestamp — showing
      // one without the other is a strange half-measure. Always visible
      // to the account's own owner regardless of this setting.
      showLastSeen: { type: Boolean, default: true },
      // Whether this account can be found via username search to start
      // a new chat. Doesn't affect chats the person is already in.
      discoverable: { type: Boolean, default: true },
    },
    // Images/files above this size won't auto-preview inline — see
    // client/src/controllers/ChatController.js's use of this alongside
    // attachment.size. Applies to both Cloud and Secret Chat attachments.
    autoDownloadLimitMb: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },
  },
  { timestamps: true }
);

// Hash the password whenever it is created or changed, never store it in plain text.
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// A Phasetime-only account (no local password ever set) should just
// never match a password login attempt, not throw when bcrypt is handed
// a null hash.
userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

// Real uploaded picture if there is one; otherwise a deterministic
// generated avatar so every account still has a face. Keyed off
// displayName when set, so someone who's set a display name gets an
// avatar with the initials/color that actually matches what's shown.
userSchema.methods.avatarUrl = function avatarUrl() {
  if (this.avatar) return this.avatar;
  const encoded = encodeURIComponent(this.displayName || this.username);
  return `https://ui-avatars.com/api/?name=${encoded}&background=random&bold=true`;
};

// Never leak the password hash to the client, even by accident.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
