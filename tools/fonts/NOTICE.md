# Fonts

IBM Plex Sans, used for the SAIF poster because the official template asks for it.

Licensed under the SIL Open Font License 1.1 — free to use, embed and redistribute.
Source: https://github.com/IBM/plex (converted here from the `@ibm/plex-sans` npm
package's woff2 files to TrueType, which is what pdf-lib can embed).

Embedding the font rather than relying on a standard PDF font matters for print:
it puts the exact glyphs and advance widths inside the file, so nothing depends
on what the printer's renderer happens to substitute.
