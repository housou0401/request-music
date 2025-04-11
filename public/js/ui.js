const UI = {
  showLoading() {
    document.getElementById("loadingIndicator").style.display = "flex";
  },
  hideLoading() {
    document.getElementById("loadingIndicator").style.display = "none";
  },
  clearSuggestions() {
    document.getElementById("suggestions").innerHTML = "";
  },
  clearSelected() {
    document.getElementById("selectedLabel").innerHTML = "";
    document.getElementById("selectedSong").innerHTML = "";
    document.getElementById("selectedArtist").innerHTML = "";
  }
};
