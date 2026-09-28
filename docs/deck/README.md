# Titration overview deck

`titration-deck.pdf` is a five-slide overview of Titration: the problem, the nine failure
origins, how a panel decides which one it was, how the fix is measured, and how to run it.

`titration-deck.html` is the editable source. After editing it, rebuild the PDF and the README
images in `docs/images/` with:

```bash
node docs/deck/build.mjs   # needs Google Chrome and network for Google Fonts; set CHROME_PATH if Chrome is not found
```

Open `titration-deck.html?slide=3` in a browser to preview a single slide.
