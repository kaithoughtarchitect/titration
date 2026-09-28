# Titration overview deck

`titration-deck.pdf` is a five-slide overview of Titration: the problem, the nine failure
origins, how a panel decides which one it was, how the fix is measured, and how to run it.

`titration-deck.html` is the editable source. After editing it, rebuild the PDF and the README
images in `docs/images/` with:

```bash
node docs/deck/build.mjs   # needs Google Chrome and network for Google Fonts; set CHROME_PATH if Chrome is not found
```

Open `titration-deck.html?slide=3` in a browser to preview a single slide.

## Social cut

`social/` holds a portrait (4:5, 1080×1350) version of the same story for feeds, with type sized
to read on a phone:

- `social/titration-social.pdf`: upload as a LinkedIn document post (it shows as a carousel).
- `social/titration-social-1.png` … `-5.png`: post as a Reddit gallery, in order.

- `social/github-social-preview.png` (1280×640): the repo's social preview, set under
  GitHub → Settings → Social preview. It is the card shown whenever the repo link is pasted.

The same `build.mjs` run rebuilds all of these from the HTML next to them.
