# Saved themes

Both folders hold the same seven design files, with their original paths kept so a
file can be copied straight back into the project root.

```
app/globals.css
app/page.module.css
components/SiteHeader.module.css
components/SiteHeader.js
components/SiteFooter.module.css
components/SiteFooter.js
components/Stories.module.css
```

## `business-theme/`

The broadsheet business paper look: newsprint greys, hairline rules, deep red, Bodoni
display headlines and the text "Trending News Kenya" masthead. This is the theme the
project now uses (taken from commit `10bf083`, just before the November redesign).

It also keeps `app/fonts/bodoni-moda.woff2`, the display face this theme needs. The
matching font setup lives in `app/layout.js`:

```js
const display = localFont({
  src: './fonts/bodoni-moda.woff2',
  variable: '--font-display',
  weight: '400 900',
  display: 'swap',
  fallback: ['Bodoni MT', 'Didot', 'Georgia', 'serif'],
})
```

and the `<html>` tag adds `${display.variable}` to its class list.

## `clean-newsroom-theme/`

The theme this project used before the revert: cool grey surfaces, vivid red, rounded
cards, logo-image masthead. It includes `app/layout.js` as it stood at that time.
Note that the file's AdSense and Search Console lines are still in the project, so
copying that `layout.js` back would drop them.

## Restoring a theme

From the project root (`Trending news kenya - Copy`):

```bash
cp "/c/xampp/htdocs/projects/newslineprojects/Digitalkenyabusinessnews/business-theme/app/globals.css" app/globals.css
# ...and the same for the other files
```

Only the theme files are here. Content, SEO metadata, wire sync and AdSense settings
were left untouched and are not part of either folder.
