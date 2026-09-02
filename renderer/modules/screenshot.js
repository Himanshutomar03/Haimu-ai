// Screenshot Module — Multi-capture support
class ScreenshotManager {
  constructor() {
    this.screenshots = [];        // Array of { dataUrl, id, source }
    this._nextId = 1;
  }

  // ---- Capture from desktop ----
  async capture() {
    try {
      const dataUrl = await window.haimuai.takeScreenshot();
      if (dataUrl) {
        return dataUrl;
      }
      throw new Error('No screenshot data received');
    } catch (error) {
      console.error('Screenshot capture failed:', error);
      throw error;
    }
  }

  // ---- Add a screenshot to the collection ----
  addScreenshot(dataUrl, source = 'capture') {
    const id = this._nextId++;
    this.screenshots.push({ id, dataUrl, source });
    return id;
  }

  // ---- Remove a screenshot by id ----
  removeScreenshot(id) {
    this.screenshots = this.screenshots.filter(s => s.id !== id);
  }

  // ---- Clear all screenshots ----
  clearScreenshots() {
    this.screenshots = [];
  }

  // ---- Get all screenshots ----
  getAllScreenshots() {
    return this.screenshots;
  }

  // ---- Get single current screenshot (first one, legacy compat) ----
  getCurrentScreenshot() {
    return this.screenshots.length > 0 ? this.screenshots[0].dataUrl : null;
  }

  // ---- Show preview modal ----
  showPreview() {
    const modal = document.getElementById('screenshotModal');
    modal?.classList.add('active');
    this._renderGallery();
  }

  // ---- Hide preview modal ----
  hidePreview() {
    const modal = document.getElementById('screenshotModal');
    modal?.classList.remove('active');
  }

  // ---- Render gallery thumbnails ----
  _renderGallery() {
    const gallery = document.getElementById('screenshotGallery');
    if (!gallery) return;

    gallery.innerHTML = '';

    this.screenshots.forEach((shot, index) => {
      const item = document.createElement('div');
      item.className = 'ss-thumb-item';
      item.dataset.id = shot.id;
      item.innerHTML = `
        <img src="${shot.dataUrl}" alt="Screenshot ${index + 1}" class="ss-thumb-img">
        <div class="ss-thumb-badge">${index + 1}</div>
        <button class="ss-thumb-remove" data-id="${shot.id}">✕</button>
      `;
      gallery.appendChild(item);
    });

    // Remove buttons
    gallery.querySelectorAll('.ss-thumb-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        this.removeScreenshot(id);
        this._renderGallery();
        this._updateCountLabel();
        // Update analyze label in app
        if (window.app?._updateAnalyzeLabel) window.app._updateAnalyzeLabel();
        // If no screenshots left, close modal
        if (this.screenshots.length === 0) {
          this.hidePreview();
        }
      });
    });

    this._updateCountLabel();
  }

  _updateCountLabel() {
    const label = document.getElementById('ssCountLabel');
    if (label) {
      const n = this.screenshots.length;
      label.textContent = n === 0 ? 'No screenshots' : `${n} screenshot${n > 1 ? 's' : ''} ready`;
    }
  }
}

window.screenshotManager = new ScreenshotManager();
