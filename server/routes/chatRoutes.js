const express = require('express');
const { wrap } = require('../utils/asyncRoutes');
const chatController = wrap(require('../controllers/chatController'));
const userController = wrap(require('../controllers/userController'));
const messageController = wrap(require('../controllers/messageController'));
const groupController = wrap(require('../controllers/groupController'));
const blockController = wrap(require('../controllers/blockController'));
const { uploadAttachment, getAttachmentBytes } = wrap(require('../controllers/uploadController'));
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const avatarUpload = require('../middleware/avatarUpload');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();

router.use(requireAuth); // every route below requires a logged-in session

const byUser = (req) => req.session.userId;
const uploadLimiter = rateLimit({ name: 'upload', windowMs: 10 * 60_000, max: 60, key: byUser, message: 'Too many uploads. Please slow down.' });
const searchLimiter = rateLimit({ name: 'search', windowMs: 60_000, max: 60, key: byUser, message: 'Too many searches. Please slow down.' });

router.get('/chats', chatController.listChats);
router.post('/chats/private', chatController.createPrivateChat);
router.post('/chats/group', chatController.createGroupChat);
router.get('/chats/:chatId/messages', chatController.getMessages);
router.post('/chats/:chatId/read', chatController.markRead);
router.post('/chats/:chatId/members', groupController.addMembers);
router.delete('/chats/:chatId/members/:userId', groupController.removeMember);
router.post('/chats/:chatId/leave', groupController.leaveGroup);
router.post('/chats/:chatId/transfer', groupController.transferOwnership);
router.patch('/messages/:messageId', messageController.editMessage);
router.delete('/messages/:messageId', messageController.deleteMessage);
router.patch('/chats/:chatId', chatController.updateGroup);
router.post('/chats/:chatId/avatar', uploadLimiter, avatarUpload.single('file'), chatController.uploadGroupAvatar);

router.get('/users/search', searchLimiter, chatController.searchUsers);
router.get('/users/blocked', blockController.listBlocked);
router.post('/users/:userId/block', blockController.block);
router.delete('/users/:userId/block', blockController.unblock);
router.patch('/users/me', userController.updateProfile);
router.post('/users/me/avatar', uploadLimiter, avatarUpload.single('file'), userController.uploadAvatar);
router.delete('/users/me/avatar', userController.removeAvatar);

router.post('/upload', uploadLimiter, upload.single('file'), uploadAttachment);
router.get('/attachments/:filename', getAttachmentBytes);

module.exports = router;
