const Search = {
  async onInput() {
    UI.clearSuggestions();
    UI.showLoading();
    let results = [];
    if (App.searchMode === 'artist') {
      if (App.artistPhase === 0) {
        const q = document.getElementById("songName").value.trim();
        if (!q) { UI.hideLoading(); return; }
        results = await Search.fetchArtists(q);
        UI.renderSuggestions(
          results.map(a => ({
            html: `<img src="${a.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;"><div><strong>${a.trackName}</strong></div>`,
            data: a
          })),
          App.selectArtist.bind(App)
        );
      } else {
        results = await Search.fetchArtistTracks(App.selectedArtistId);
        UI.renderSuggestions(
          results.map(s => ({
            html: `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`,
            data: s
          })),
          App.selectSong.bind(App)
        );
      }
    } else {
      const song = document.getElementById("songName").value.trim();
      const artist = document.getElementById("artistName").value.trim();
      if (!song) { UI.hideLoading(); return; }
      results = await Search.fetchSongs(song, artist);
      UI.renderSuggestions(
        results.map(s => ({
          html: `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`,
          data: s
        })),
        App.selectSong.bind(App)
      );
    }
    UI.hideLoading();
  },
  fetchSongs(track, artist) {
    return fetch(`/search?query=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}`)
      .then(r => r.ok ? r.json() : []);
  },
  fetchArtists(name) {
    return fetch(`/search?mode=artist&query=${encodeURIComponent(name)}`)
      .then(r => r.ok ? r.json() : []);
  },
  fetchArtistTracks(id) {
    return fetch(`/search?mode=artist&artistId=${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : []);
  }
};
