import { $, $$, el } from '../utils/dom.js';

export class ModalView {
  constructor() {
    this.newMenuBtn = $('#new-menu-btn');
    this.newMenu = $('#new-menu');

    this.newMenuBtn.addEventListener('click', () => this.newMenu.classList.toggle('hidden'));
    document.addEventListener('click', (e) => {
      if (!this.newMenuBtn.contains(e.target) && !this.newMenu.contains(e.target)) {
        this.newMenu.classList.add('hidden');
      }
    });

    $$('[data-open-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.newMenu.classList.add('hidden');
        $(`#${btn.dataset.openModal}`).classList.remove('hidden');
      });
    });
    $$('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.fixed').classList.add('hidden'));
    });
  }

  closeNewChatModal() {
    $('#new-chat-modal').classList.add('hidden');
    $('#user-search-input').value = '';
    $('#user-search-results').innerHTML = '';
  }

  closeNewGroupModal() {
    $('#new-group-modal').classList.add('hidden');
    $('#group-name-input').value = '';
    $('#group-user-search-input').value = '';
    $('#group-user-search-results').innerHTML = '';
    $('#group-selected').innerHTML = '';
  }

  buildUserRow(user, onClick) {
    const img = el('img', 'w-8 h-8 rounded-full object-cover');
    img.src = user.avatarUrl;
    const row = el('button', 'w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-mist text-left', [
      img,
      el('span', 'text-sm font-medium', user.username),
    ]);
    row.type = 'button';
    row.addEventListener('click', onClick);
    return row;
  }

  renderUserSearchResults(users, onPick) {
    const container = $('#user-search-results');
    container.innerHTML = '';
    users.forEach((u) => container.appendChild(this.buildUserRow(u, () => onPick(u))));
  }

  renderGroupUserSearchResults(users, onPick) {
    const container = $('#group-user-search-results');
    container.innerHTML = '';
    users.forEach((u) => container.appendChild(this.buildUserRow(u, () => onPick(u))));
  }

  renderGroupSelected(selectedMap, onRemove) {
    const container = $('#group-selected');
    container.innerHTML = '';
    selectedMap.forEach((user, username) => {
      const removeBtn = el('button');
      removeBtn.type = 'button';
      removeBtn.className = 'text-slate hover:text-ember';
      removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      removeBtn.addEventListener('click', () => onRemove(username));

      const chip = el('span', 'inline-flex items-center gap-1.5 bg-mist text-ink text-xs font-medium pl-2.5 pr-1.5 py-1 rounded-full', [
        document.createTextNode(username),
        removeBtn,
      ]);
      container.appendChild(chip);
    });
  }
}
