"""The perch suite's logos. Each is a produce bag holding the tool's name
and its sign, on lede's tile; the lockup adds the tiles of what it runs on.

Letters come from SF Compact Rounded Black converted to paths, so the SVGs
need no installed font. Writes <root>/<name>/logo.svg (lockup) and icon.svg
(32 px mark) for each tool; root defaults to the folder holding perch.

    python3 docs/logo/suite.py [root]
"""
import math, os, random, re, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "..")

FONT = TTFont("/Library/Fonts/SF-Compact-Rounded-Black.otf")
GS = FONT.getGlyphSet()
CMAP = FONT.getBestCmap()
UPM = FONT["head"].unitsPerEm
XH = FONT["OS/2"].sxHeight


class _Pts:
    def __init__(self): self.pts = []
    def moveTo(self, p): self.pts.append(p)
    lineTo = moveTo
    def curveTo(self, *ps): self.pts.extend(ps)
    def qCurveTo(self, *ps): self.pts.extend(p for p in ps if p)
    def closePath(self): pass
    endPath = closePath
    def addComponent(self, *a): pass


def glyph_points(ch, size):
    g = GS[CMAP[ord(ch)]]
    bp = BoundsPen(GS); g.draw(bp)
    x0, y0, x1, y1 = bp.bounds
    s = size / UPM
    rec = _Pts()
    g.draw(TransformPen(rec, (s, 0, 0, -s, -(x0 + x1) / 2 * s, XH / 2 * s)))
    return rec.pts


def hull(points):
    pts = sorted(set((round(x, 1), round(y, 1)) for x, y in points))
    def cross(o, a, b): return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def reduce_hull(poly, n, keep):
    poly = list(poly)
    def tri(a, b, c): return abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2
    while len(poly) > n:
        costs = [(tri(poly[i-1], poly[i], poly[(i+1) % len(poly)]), i) for i in range(len(poly)) if poly[i] not in keep]
        if not costs: break
        poly.pop(min(costs)[1])
    return poly


def pad(points, r):
    return [(x + r * math.cos(a * math.pi / 6), y + r * math.sin(a * math.pi / 6)) for x, y in points for a in range(12)]


def glyph(ch, size):
    """Path of `ch` at font size `size`, centred on its x-height box (0,0)."""
    g = GS[CMAP[ord(ch)]]
    bp = BoundsPen(GS)
    g.draw(bp)
    x0, y0, x1, y1 = bp.bounds
    s = size / UPM
    cx = (x0 + x1) / 2
    cy = XH / 2  # centre on x-height so ascenders/descenders stick out naturally
    pen = SVGPathPen(GS, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    g.draw(TransformPen(pen, (s, 0, 0, -s, -cx * s, cy * s)))
    return pen.getCommands(), (x1 - x0) * s


PROJECTS = {
    "perch": dict(tilt=-12, ground="#620B85", ink="#30F570",
                  rows=["pe@bird", "rch"], size=70, seed=3, extra="bird", er=19),
    "avis": dict(tilt=20, ground="#F70041", ink="#B7CBE8",
                 rows=["av@pin", "is"], size=76, seed=11, gap=0.16, tumble=22, extra="pin", er=25),
    "rooms": dict(tilt=-4, ground="#0C4A4A", ink="#FFB27A",
                  rows=["ro@key", "oms"], size=62, seed=5, extra="key", er=22),
    "figma-cdp": dict(tilt=28, ground="#FFB3D9", ink="#0B6B3A",
                      rows=["fi@nib", "gma", "-cdp"], size=52, seed=7, tumble=22, er_k=0.5, extra="nib", er=21),
    "trabAGItos": dict(tilt=-20, ground="#74ACDF", ink="#FFFFFF",
                       rows=["trab", "AGI", "tos@sun"], size=52, gap=0.08, seed=9, extra="sun", er=20),
    "loft": dict(tilt=10, ground="#F2B705", ink="#1B2466",
                 rows=["lo", "ft@screen"], size=72, seed=13, extra="screen", er=24),
}

def tokens(row):
    """'pe@bird' -> ['p', 'e', '@bird']"""
    return re.findall(r"@(?:bird|pin|key|nib|sun|screen)|.", row)


def pile(p):
    rnd = random.Random(p["seed"])
    rows = p["rows"]
    size = p["size"]
    er = p["er"] = size * p.get("er_k", 0.44)
    step = size * 0.70
    bottom = 160
    out, pts = [], []
    p["_slots"] = []
    n = 0
    for ri, row in enumerate(reversed(rows)):
        y = bottom - ri * step
        items = tokens(row)
        widths = [2 * er + size * 0.3 if t[0] == "@" else glyph(t, size)[1] for t in items]
        gap = size * p.get("gap", 0.07)
        total = sum(widths) + gap * (len(items) - 1)
        x = 100 + p.get("x_shift", 0) - total / 2
        for t, w in zip(items, widths):
            cx = x + w / 2 + rnd.uniform(-2.5, 2.5)
            cy = y + rnd.uniform(-3, 3)
            side = 1 if (n % 2) else -1
            n += 1
            if t[0] == "@":
                kind = t[1:]
                r = 4 if kind == "bird" else rnd.uniform(-16, 16)
                p["_slots"].append((kind, cx, cy - size * 0.08, r))
            else:
                # each letter tumbles its own way: alternate sides, varied amount
                rot = side * rnd.uniform(8, p.get("tumble", 30))
                if t.isupper() and sum(c.isupper() for c in row) > 1:
                    rot = p.setdefault("_caps_rot", {}).setdefault(ri, rnd.uniform(-6, 6))
                d, _ = glyph(t, size)
                out.append(f'<path d="{d}" transform="translate({cx:.1f} {cy:.1f}) rotate({rot:.1f})"/>')
                a = math.radians(rot)
                for gx, gy in glyph_points(t, size):
                    pts.append((cx + gx * math.cos(a) - gy * math.sin(a), cy + gx * math.sin(a) + gy * math.cos(a)))
            x += w + gap
    return out, pts, bottom - (len(rows) - 1) * step


NAT_R = {"bird": 27, "pin": 25, "key": 28, "nib": 24, "sun": 26, "screen": 26}

# One outline per project, same stroke weight as the letters' visual weight.
OUTLINE = {
    "bird":  "M-26 -4 L-16 -8 A10 10 0 0 1 2 -10 L26 -18 L16 4 Q8 18 -6 16 Q-18 14 -16 -2 Z M-8 -6 L-7 -6",
    "pin":   "M-8 18 L-12 24 L-2 20 A20 20 0 1 0 -8 18 Z",
    "key":   "M-22 0 L-22 22 L22 22 L22 0 L0 -20 Z",                      # house: rooms
    "nib":   "M0 -24 L16 2 L8 22 L-8 22 L-16 2 Z M0 -24 L0 4",
    "sun":   "M0 -12 A12 12 0 1 0 0.01 -12 Z",
    "screen": "M-24 -16 L24 -16 L24 12 L-24 12 Z M0 12 L0 21 M-10 21 L10 21",  # monitor: loft
}


def extra(kind, p, hnd=None):
    out = []
    for kind, sx, sy, srot in p["_slots"]:
        k = p["er"] / NAT_R[kind]
        colour = "#F6B40E" if kind == "sun" else p["ground"]
        rays = ""
        if kind == "sun":
            rays = "".join(f' M{18*math.cos(i*math.pi/4):.1f} {18*math.sin(i*math.pi/4):.1f} L{25*math.cos(i*math.pi/4):.1f} {25*math.sin(i*math.pi/4):.1f}' for i in range(8))
        out.append(f'<path d="{OUTLINE[kind]}{rays}" transform="translate({sx:.1f} {sy:.1f}) rotate({srot:.1f}) scale({k:.3f})" '
                   f'fill="none" stroke="{colour}" stroke-width="{8.5 / k * (p["size"] / 60):.1f}" stroke-linejoin="round" stroke-linecap="round"/>')
    return "\n".join(out)


TILT = 14
# lede's tile outline (512 units); only its outer shape is used
SQUIRCLE = "M327.68 0c64.518 0 96.777 0 121.42 12.556a115.2 115.2 0 0 1 50.344 50.344c12.556 24.643 12.556 56.902 12.556 121.42L512 327.68c0 64.518 0 96.777 -12.556 121.42a115.2 115.2 0 0 1 -50.344 50.344c-24.643 12.556 -56.902 12.556 -121.42 12.556L184.32 512c-64.518 0 -96.777 0 -121.42 -12.556a115.2 115.2 0 0 1 -50.344 -50.344c-12.556 -24.643 -12.556 -56.902 -12.556 -121.42L0 184.32c0 -64.518 0 -96.777 12.556 -121.42a115.2 115.2 0 0 1 50.344 -50.344c24.643 -12.556 56.902 -12.556 121.42 -12.556Z"
TILE = f'<path d="{SQUIRCLE}" transform="scale(0.390625)" fill="{{g}}"/>'  # the bag hangs from its knot, so it leans


def rot(pt, t, c=(100, 110)):
    a = math.radians(t)
    x, y = pt[0] - c[0], pt[1] - c[1]
    return (c[0] + x * math.cos(a) - y * math.sin(a), c[1] + x * math.sin(a) + y * math.cos(a))


def produce_bag(p, pile_pts, film_r=7, ear=30):
    """Produce bag tied at the top. The film is the hull of the contents, rounded where
    it wraps them (round-joined stroke = dilation), narrowing to a knot with two ears."""
    pts = list(pile_pts)
    for _, ex, ey, _ in p.get("_slots", []):
        er = p["er"]
        pts += [(ex + er * math.cos(t / 8 * math.pi), ey + er * math.sin(t / 8 * math.pi)) for t in range(16)]
    top = min(y for _, y in pts)
    xs = [x for x, y in pts]
    kx, ky = (min(xs) + max(xs)) / 2 + p.get("knot_dx", 6), top - p.get("neck", 22)
    outline = hull(pts + [(kx - 3, ky), (kx + 3, ky)])
    d_hull = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in outline) + " Z"
    ears = (f'<ellipse cx="{kx:.1f}" cy="{ky - ear / 2:.1f}" rx="{ear * 0.22:.1f}" ry="{ear / 2:.1f}" transform="rotate(12 {kx:.1f} {ky:.1f})"/>'
            f'<ellipse cx="{kx:.1f}" cy="{ky - ear / 2:.1f}" rx="{ear * 0.22:.1f}" ry="{ear / 2:.1f}" transform="rotate(58 {kx:.1f} {ky:.1f})"/>'
            f'<ellipse cx="{kx:.1f}" cy="{ky:.1f}" rx="{film_r + 2:.1f}" ry="{film_r:.1f}"/>')
    film = (f'<path d="{d_hull}" stroke-width="{2 * film_r}" stroke-linejoin="round"/>' + ears)
    # extent for fitting: hull dilated + ear tips
    ext = pad(outline, film_r) + [(kx + ear * math.sin(math.radians(t)), ky - ear * math.cos(math.radians(t))) for t in (12, 58)]
    return film, ext


def fit(ext, tilt, margin=12):
    r = [rot(q, tilt) for q in ext]
    x0, x1 = min(x for x, _ in r), max(x for x, _ in r)
    y0, y1 = min(y for _, y in r), max(y for _, y in r)
    s = min((200 - 2 * margin) / (x1 - x0), (200 - 2 * margin) / (y1 - y0), 1.8)
    tx = 100 - s * (x0 + x1) / 2
    ty = 100 - s * (y0 + y1) / 2
    return f"translate({tx:.1f} {ty:.1f}) scale({s:.3f}) rotate({tilt} 100 110)"


def mark(name, p):
    paths, pts, _ = pile(p)
    letters = "\n  ".join(paths)
    filmsvg, ext = produce_bag(p, pts)
    ex = extra(p["extra"], p)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
<title>{name}</title>
{TILE.format(g=p["ground"])}
<g transform="{fit(ext, p.get('tilt', TILT), 8)}">
<g opacity="1" fill="{p["ink"]}" stroke="{p["ink"]}">{filmsvg}</g>
{ex}
<g fill="{p["ground"]}">
  {letters}
</g>
</g>
</svg>
'''


def small(name, p):
    """32-px mark: the same tied bag around the initial alone."""
    size = 140
    d, _ = glyph(name[0], size)
    cx, cy = 100, 120
    lr = -0.7 * p.get("tilt", TILT)  # the initial leans against the bag
    pts = [rot((cx + gx, cy + gy), lr, (cx, cy)) for gx, gy in glyph_points(name[0], size)]
    q = dict(p, extra="", knot_dx=0, neck=26, _slots=[])
    filmsvg, ext = produce_bag(q, pts, film_r=14, ear=44)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="32" height="32">
<title>{name}</title>
{TILE.format(g=p["ground"])}
<g transform="{fit(ext, p.get('tilt', TILT), 10)}">
<g opacity="1" fill="{p["ink"]}" stroke="{p["ink"]}">{filmsvg}</g>
<path d="{d}" transform="translate({cx} {cy}) rotate({lr:.1f})" fill="{p["ground"]}"/>
</g>
</svg>
'''


# Lockup: the tool's tile, and to its right a column with the tiles of what it
# runs on. perch has all of them.
BESIDE = {"perch": ["avis", "rooms", "figma-cdp", "trabAGItos", "loft"], "avis": ["perch"], "rooms": ["perch"],
          "figma-cdp": ["perch", "rooms"], "trabAGItos": ["perch"], "loft": ["perch", "rooms"]}


def inner(svg):
    return svg.split(">", 1)[1].rsplit("</svg>", 1)[0].replace(f"<title>", "<!--").replace("</title>", "-->")


def lockup(name, marks, smalls):
    big = inner(marks[name])
    row = BESIDE[name]
    gap, left = 8.0, 212
    m = min(44, (200 - gap * (len(row) - 1)) / len(row))
    y0 = 100 - (len(row) * m + (len(row) - 1) * gap) / 2
    minis = "".join(
        f'<svg x="{left}" y="{y0 + i * (m + gap):.1f}" width="{m}" height="{m}" viewBox="0 0 200 200">{inner(smalls[n])}</svg>'
        for i, n in enumerate(row))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {left + m} 200" width="{left + m}" height="200">'
            f'<title>{name}</title>{big}{minis}</svg>\n')


marks = {name: mark(name, p) for name, p in PROJECTS.items()}
smalls = {name: small(name, p) for name, p in PROJECTS.items()}
for name in PROJECTS:
    with open(os.path.join(ROOT, name, "logo.svg"), "w") as f: f.write(lockup(name, marks, smalls))
    with open(os.path.join(ROOT, name, "icon.svg"), "w") as f: f.write(smalls[name])
