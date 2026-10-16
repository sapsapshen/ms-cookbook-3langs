# Website artwork refinements

The purple book, sky, landscape, and page layout are retained from the existing site. Only paper-airplane imagery was removed from the desktop hero, mobile hero, and sky-strip backgrounds with the built-in image-generation editor on 2026-09-15. The original site assets remain in `assets/paper/` for provenance and recovery.

Final web assets: `hero-no-plane.webp`, `mobile-hero-no-plane.webp`, and `sky-no-plane.webp`. The original generated PNGs are preserved in the local generation archive, outside the website payload.

## Edit prompts

- Desktop hero — precise-object-edit: remove all four white paper airplanes and associated curved flight trails/sparkles. Inpaint to match the pale purple-blue sky and book pages. Preserve the open low-poly book, position, shape, size, polygon mountains, floating rocks, lighting, palette, negative space, bottom white fade, and 4:3 composition. No new objects, characters, or text.
- Mobile hero — precise-object-edit: remove the two paper airplanes and looping trail, including the tiny purple beads on it. Preserve the open low-poly book, size and placement, polygon terrain, larger floating rocks, lighting, purple-cyan gradient, upper negative space, bottom white fade, and portrait proportions. No new objects or text.
- Sky strip — precise-object-edit: remove the upper-right paper airplane and its thin flight trail with purple beads. Preserve the pale cyan sky, purple corners, faceted rocks, mountains, white fade, and panoramic composition. No new objects, text, or characters.

The cyan Dada character is provided by [NovaWang97/dada-illustrations](https://github.com/NovaWang97/dada-illustrations), commit `468b026234ae91671d37bcd3e10bcc99fc4a7b14`. The canonical reference is retained unmodified at `../dada/dada-ip-reference.png`; `../dada/dada.webp` is a resized web delivery copy. See its [MIT license](../dada/LICENSE) and [upstream notice](../dada/NOTICE.md).

The community QR image was supplied in the client feedback document. It is separate from the Dada repository author's contact QR.
