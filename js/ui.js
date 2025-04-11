const UI = {
  showLoading() {
    document.getElementById("loadingIndicator").style.display = "flex";
  },
  hideLoading() {
    document.getElementById("loadingIndicator").style.display = "none";
  },
  setModeButtons(mode) {
    document.getElementById("modeSong").classList.toggle("active", mode === "song");
    document.getElementById("modeArtist").classList.toggle("active", mode === "artist");
  },
  clearSuggestions() {
    document.getElementById("suggestions").innerHTML = "";
  },
  renderSuggestions(items, onClick) {
    const c = document.getElementById("suggestions");
    c.innerHTML = "";
    items.forEach(i => {
      const div = document.createElement("div");
      div.className = "suggestion-item";
      div.innerHTML = i.html;
      div.onclick = () => onClick(i.data);
      c.appendChild(div);
    });
  },
  renderSelectedSong(song, controlsHtml) {
    document.getElementById("selectedLabel").innerHTML =
      `<div class="selected-label">選択中の曲</div>`;
    document.getElementById("selectedSong").innerHTML = `
      <div class="selected-item">
        <div style="display:flex;align-items:center;">
          <img src="${song.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
          <div><strong>${song.trackName}</strong><br><small>${song.artistName}</small></div>
        </div>
        <div style="display:flex;align-items:center;">${controlsHtml}</div>
      </div>`;
  },
  renderSelectedArtist(artist) {
    document.getElementById("selectedArtist").innerHTML = `
      <div class="selected-label">選択中のアーティスト</div>
      <div class="selected-item">
        <div style="display:flex;align-items:center;">
          <img src="${artist.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
          <div><strong>${artist.trackName}</strong></div>
        </div>
        <button class="clear-btn" onclick="App.clearArtist()">×</button>
      </div>`;
  },
  clearSelected() {
    document.getElementById("selectedLabel").innerHTML = "";
    document.getElementById("selectedSong").innerHTML = "";
    document.getElementById("selectedArtist").innerHTML = "";
  },
  clearInput(id) {
    document.getElementById(id).value = "";
  }
};
