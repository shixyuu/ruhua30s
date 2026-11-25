#!/usr/bin/env python3
"""
Self-hosted font subsetting (no Google Fonts CDN at runtime).

Latin faces keep ASCII + a few typographic symbols; the CJK display face keeps
only the five characters of the logo mark (入画三十秒).
Output: client/src/fonts/*.woff2 (bundled by Vite with hashed names).

Usage:
  pip install fonttools brotli
  FONT_SRC=/path/to/ttf python3 scripts/subset-fonts.py
FONT_SRC must contain (all from github.com/google/fonts):
  Archivo-VariableFont_wdth,wght.ttf     (ofl/archivo)          SIL OFL 1.1
  CourierPrime-Regular.ttf / -Bold.ttf   (ofl/courierprime)     SIL OFL 1.1
  IBMPlexMono-Regular.ttf / -Medium.ttf  (ofl/ibmplexmono)      SIL OFL 1.1
  InstrumentSerif-Regular.ttf / -Italic  (ofl/instrumentserif)  SIL OFL 1.1
  PermanentMarker-Regular.ttf            (apache/permanentmarker) Apache 2.0
  ZCOOLXiaoWei-Regular.ttf               (ofl/zcoolxiaowei)     SIL OFL 1.1
"""
import os, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get('FONT_SRC', '/tmp/fonts2')
OUT = os.path.join(ROOT, 'client', 'src', 'fonts')
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.woff2'):
        os.remove(os.path.join(OUT, f))

ascii_ = ''.join(chr(c) for c in range(0x20, 0x7f))
latin = ascii_ + '·—–…→←↑↓×°‘’“”•▸◀▶■□●○№✓✗±§'

def build(src, out, chars, axes=None):
    path = os.path.join(SRC, src)
    if not os.path.exists(path):
        print('missing', path); sys.exit(1)
    font = TTFont(path)
    if axes and 'fvar' in font:
        font = instancer.instantiateVariableFont(font, axes)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['kern', 'liga', 'tnum', 'case', 'ss01', 'zero']
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    opts.hinting = False
    opts.desubroutinize = True
    s = subset.Subsetter(opts)
    s.populate(text=chars)
    s.subset(font)
    dst = os.path.join(OUT, out)
    font.flavor = 'woff2'
    font.save(dst)
    print(f'{out:30s} {os.path.getsize(dst)/1024:7.1f} KB')

V = 'Archivo-VariableFont_wdth,wght.ttf'
build(V, 'rh-grot-800.woff2', latin, {'wdth': 62, 'wght': 800})   # signage, extra-condensed heavy
build(V, 'rh-grot-600.woff2', latin, {'wdth': 75, 'wght': 600})   # labels, condensed
build(V, 'rh-sans-400.woff2', latin, {'wdth': 100, 'wght': 400})  # body
build(V, 'rh-sans-700.woff2', latin, {'wdth': 100, 'wght': 700})
build('CourierPrime-Regular.ttf', 'rh-type-400.woff2', latin)      # typewriter (tickets)
build('CourierPrime-Bold.ttf', 'rh-type-700.woff2', latin)
build('IBMPlexMono-Regular.ttf', 'rh-mono-400.woff2', latin)       # timecode
build('IBMPlexMono-Medium.ttf', 'rh-mono-500.woff2', latin)
build('InstrumentSerif-Regular.ttf', 'rh-serif-400.woff2', latin)  # editorial captions
build('InstrumentSerif-Italic.ttf', 'rh-serif-400i.woff2', latin)
build('PermanentMarker-Regular.ttf', 'rh-marker-400.woff2', ascii_ + '✓×→↑')  # grease pencil
build('ZCOOLXiaoWei-Regular.ttf', 'rh-mark-cjk.woff2', '\u5165\u753b\u4e09\u5341\u79d2')  # logo mark only
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f'total {total/1024:.1f} KB')
