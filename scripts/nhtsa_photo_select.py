#!/usr/bin/env python3
"""Pick the photos mcp.vin shows from one NHTSA crash test's photo set, by the photo's file name.

NHTSA's vehicle crash-test database (nrd.api.nhtsa.dot.gov get-multimedia-files/<test>) lists every photo the test
lab took: whole-car views before and after the test, plus labels, placards, dummies, seats, belts, underbody,
engine bay, instrumentation and so on. Only the lab's file name (`originalFileName`) says what a photo shows, and
the wording differs by lab and year:
  "No. 001 - As-Delivered Right Front 3-4 View of Test Vehicle.jpg"       (Karco)
  "Photo #001 - As Delivered Right Front Three-Quarter View of Test Vehicle.JPG"   (Calspan)
  "No. 006 Left Rear 3-4 View, As Received.jpg"                            (MGA)
  "No. 005   2013 Jeep Patriot Sport 4x4 Frontal As Delivered.JPG"         (TRC)
  "2016 Buick Envision AWD Premium II 5-Dr SUV Side NCAP MDB IMPACT FOR WEB.jpg"  (MGA)

Rules (fail closed: a name that does not clearly say "the whole car, before or after the test, from this side" is
never used; a camera file name such as IMG_1234.jpg says nothing and is never used):
1. classify(name) reads one name. It returns None unless the name, once numbering, phase words and filler
   ("of test vehicle", "view", "for web") are taken away, is only a view of the car: left/right/driver/passenger,
   front/frontal/rear, side, three-quarter (3-4, 3/4, ¾). Two longer forms are also read: "<year> <vehicle name>
   <test> As Delivered|As Received" (view angle not stated) and "<year> <vehicle name> <test> Impact (event|photo)
   for web" (NHTSA's own photo of the impact moment). Any word of EXCLUDE anywhere rejects the name.
   phase: 'pre' (pre-test, as delivered, as received), 'post' (post-test, post-impact), 'impact' (the moment of
   impact). A name without a phase is rejected.
2. choose(photos, kind, struck) keeps for one test: up to PRE_MAX whole-car views before the test (one per view
   group, the front three-quarter first) and the best whole-car view after the test for that test's kind
   (frontal: the front three-quarter; side and pole: the struck side; rear: the rear three-quarter). Photos of the
   impact moment are recognised (so they are never mistaken for a view) but not kept: most are 222x127 web
   thumbnails or high-speed camera frames, and the after-the-test view shows the damage more plainly.
"""
import re

PHASES = (
    ('pre', r'\bpre[- ]?(?:test|impact|crash)\b|\bas[- ]?delivered\b|\bas[- ]?received\b|\bbefore (?:the )?test\b|\bpre\b'),
    ('post', r'\bpost[- ]?(?:test|impact|crash)\b|\bafter (?:the )?test\b|\bpost\b'),
)
# Anywhere in the name: never a whole-car view (or not only the car). Word boundaries keep vehicle names such as
# Charger, Trailblazer, Mountaineer, Liftback and "All-Wheel Drive" from matching.
EXCLUDE_WORDS = (
    r'dumm(?:y|ies)', r'\batd\b', 'placard', 'label', 'monroney', 'sticker', 'under ?-?body', 'under ?carriage', 'underside',
    'engine', 'compartment', 'wind ?shield', 'steering', 'seat', 'belt', 'anchor', 'ballast', 'brake', 'filler',
    'fuel(?! cell)', 'trap', 'read-?out', 'overhead', 'aerial', 'target', 'load ?cell', 'wall', 'floor', 'latch',
    'door ?panel', 'inner door', 'knee', 'bolster', 'head ?rest', 'restraint', 'interior', 'close ?-?up', 'detail',
    'rollover', 'camera', 'instrument', 'accelerometer', 'battery', 'propulsion', 'high voltage', 'electrical',
    r'\bcharg(?:e|ing)\b', 'isolation', 'tire', 'wheel(?![- ]drive)', r'\brim\b', 'cable', r'\bsill', 'pillar', 'pedal',
    'air ?-?bag', 'curtain', 'contact', 'solvent', 'spill', 'leak', 'crush', 'measur', 'marking', 'fore-?aft',
    r'\bface\b', r'\bdash', 'glove', 'console', 'cargo area', 'trunk', r'\bhood\b', r'\broof', 'top view', 'odometer',
    'gauge', r'\bkey\b', 'manual', 'certification', 'emblem', 'badge', 'suspension', r'\brail\b', 'bumper', 'lamp',
    'mirror', 'window', 'glass', 'handle', 'hinge', 'striker', r'\btank\b', 'wiring', 'harness', 'occupant', 'child',
    'booster', 'tether', 'clearance', 'reference', 'ruler', r'\bgrid\b', r'\bscale\b', 'weigh', 'attitude', r'\bclock',
    r'\bvin\b', 'shattered', 'zoom', 'inside', r'\bcabin\b', 'switch', 'bracket', r'\bmount\b', 'fixture', r'\btow\b',
    'hitch', 'spare', r'\bjack\b', r'\bpaint', r'\btape\b', 'template', 'survey', r'\blift\b', 'hoist', 'crane', r'\bsled',
    r'\bfilm\b', 'video', r'\bframe\b', 'chalk', 'cradle', r'\baxle', 'exhaust', 'muffler', 'radiator', 'grille',
    'license', r'\bplate\b', r'\blogo\b', 'vehicle id', r'\bstatic\b', 'thigh', 'chest', 'pelvis', 'pubic', r'\bneck\b',
    r'\bhead\b', 'torso', r'\brib\b', 'spine', r'\bfeet\b', r'\bfoot\b', 'barrier', 'impactor', 'positioned', 'against',
    r'\bpole barrier', 'onboard', 'on-board', r'\bclose\b', 'speedometer', 'tachometer', 'gear', 'shifter', 'pretensioner', 'retractor', 'buckle',
)
EXCLUDE = re.compile('|'.join(EXCLUDE_WORDS))

# "driver" and "passenger" are not sides here: in these names they mean a dummy or seat ("Pre-Test Right Front Passenger
# Front View" is the passenger dummy), so a name with them is not read as a whole-car view.
SIDES = {'left': 'left', 'lh': 'left', 'right': 'right', 'rh': 'right'}
ENDS = {'front': 'front', 'frontal': 'front', 'rear': 'rear', 'back': 'rear'}
QUARTER = {'3-4', '3/4', '¾', 'three-quarter', 'three-quarters', 'three', 'quarter', '+', '34', 'oblique', '3', '4'}
FILLER = {'view', 'views', 'of', 'the', 'test', 'vehicle', 'car', 'photo', 'photograph', 'side', 'for', 'web', 'and', 'shot'}
# The test the "<year> <vehicle> <test> ..." forms name.
TEST_WORDS = r'(?:(?:side|frontal|front|rear|ncap|mdb|pole|nca|impact|oblique|barrier|fmvss\s*\d+|35\s*mph|-)\s*)+'

VIEW_GROUP = {'front_34_left': 'front_34', 'front_34_right': 'front_34', 'front_34': 'front_34', 'as_delivered': 'front_34',
              'side_left': 'side', 'side_right': 'side', 'side': 'side', 'rear_34_left': 'rear_34', 'rear_34_right': 'rear_34',
              'rear_34': 'rear_34', 'front': 'front', 'rear': 'rear'}
# Before the test: the main photo first. 'as_delivered' (a "<vehicle> Frontal As Delivered" photo, angle not stated)
# ranks with the front three-quarter: the labs take it as the vehicle's portrait.
PRE_ORDER = ['front_34_left', 'front_34_right', 'front_34', 'as_delivered', 'side_left', 'side_right', 'side',
             'rear_34_left', 'rear_34_right', 'rear_34', 'front', 'rear']
PRE_MAX = 3


def normalize(name):
    """Lower case, no extension(s), no numbering prefix, single spaces."""
    n = str(name or '').replace('\u00a0', ' ').replace('_', ' ')
    n = re.sub(r'\.(?:jpe?g|png|tiff?|bmp|gif)\b', ' ', n, flags=re.I).lower()
    n = re.sub(r'\s+', ' ', n).strip()
    # numbering: "photo no. 006 -", "photo #001 -", "photo 0010 -", "no. - 005.", "no. 5", "figure a-5,", "069 ", "p006 -"
    n = re.sub(r'^(?:(?:photo\s*)?(?:no\.?|#|number)|photo|figure\s+[a-z]?-?|fig\.?\s*[a-z]?-?)\s*[-.#]?\s*\d{1,4}[a-z]?(?!\d)\s*[-.,:)]*\s*', '', n)
    n = re.sub(r'^p?\d{1,3}[a-z]?(?!\d)\s*[-.,:)]*\s*', '', n)
    n = re.sub(r'^[-.,:#\s]+', '', n)
    return re.sub(r'\s+', ' ', n).strip()


def _phase(text):
    found = [(p, m) for p, rx in PHASES for m in re.finditer(rx, text)]
    phases = {p for p, _ in found}
    if len(phases) != 1:
        return None, text
    for _, m in found:
        text = text.replace(m.group(0), ' ')
    return phases.pop(), text


def _view(text):
    """The view the remaining words describe, or None when any other word is left."""
    words = re.findall(r"[a-z0-9'¾+/-]+", text.replace(',', ' '))
    side = end = None
    quarter = False
    for w in words:
        w = w.strip('-')
        if not w:
            continue
        if w in SIDES:
            if side and side != SIDES[w]:
                return None
            side = SIDES[w]
        elif w in ENDS:
            if end and end != ENDS[w]:
                return None
            end = ENDS[w]
        elif w in QUARTER:
            quarter = True
        elif w in FILLER:
            continue
        else:
            return None
    has_side_word = 'side' in words
    if end and (quarter or side):
        if has_side_word and not side:
            return None  # "rear side view": which side, which end?
        return f'{end}_34_{side}' if side else f'{end}_34'
    if quarter:
        return None  # a three-quarter view of which end?
    if end:
        if has_side_word or ('frontal' in words and 'view' not in words):
            return None  # "rear side view"; "Frontal As Delivered" names the frontal test, not the angle
        return end
    if side:
        return f'side_{side}'
    if has_side_word:
        return 'side'
    return None


YEAR_NAME = r'(?:19|20)\d\d\b[^,]*?[ -]'  # "2016 Buick Envision AWD Premium II 5-Dr SUV " (vehicle name, as the lab wrote it)
PHASE_WORD = re.compile(r'\b(?:pre|post)\b|\b(?:pre|post)[- ]?(?:test|impact|crash)\b|\bas[- ]?(?:delivered|received)\b')
IMPACT = re.compile(r'(?:' + YEAR_NAME + r'|test vehicle |vehicle )?(?:' + TEST_WORDS + r')?'
                    r'impact(?: event)?(?: photo(?:graph)?| still)?(?: for web)?(?: \d+sc)?')
AS_DELIVERED = re.compile(r'(?:' + YEAR_NAME + r'|(?:test )?vehicle )?(?:' + TEST_WORDS + r')?as[- ]?(?:delivered|received)'
                          r'(?: ' + TEST_WORDS + r')?(?: for web)?')


def classify(name):
    """{'phase', 'view', 'web'} for a whole-car photo name, else None. See the module notes."""
    n = normalize(name)
    if not n or EXCLUDE.search(n):
        return None
    web = bool(re.search(r'\bfor web\b', n))
    original = n
    # "<year> <vehicle name> <test> impact [event|photo] for web", "impact photograph", "vehicle impact": the moment of impact.
    if IMPACT.fullmatch(n) and not PHASE_WORD.search(n):
        return {'phase': 'impact', 'view': None, 'web': web}
    # "<year> <vehicle name> as delivered right front three-quarter view", "<year> <vehicle name> front 3-4 view as received":
    # the vehicle name goes up to the first phase or view word, and the rest must name a view ("view", a side or a
    # three-quarter); "<vehicle> Frontal Post Test" names the test, not the angle.
    named = re.sub(r'^(?:19|20)\d\d\b.*?[ -](?=(?:as[- ]?delivered|as[- ]?received|pre[- ]?test|post[- ]?test|left|right|front|frontal|rear)\b)', '', n)
    if named != n:
        if not re.search(r'\bview\b|\bleft\b|\bright\b|3-4|3/4|¾|three', named):
            named = None
        n = named or ''
    phase, rest = _phase(n) if n else (None, '')
    view = _view(rest) if phase else None
    if view:
        return {'phase': phase, 'view': view, 'web': web}
    # "<year> <vehicle name> <test> as delivered [for web]": before the test, angle not stated.
    if AS_DELIVERED.fullmatch(original):
        return {'phase': 'pre', 'view': 'as_delivered', 'web': web}
    return None


def test_kind(config, angle):
    """frontal, side (moving barrier into the side), pole, rear (moving barrier into the rear), or None."""
    c = str(config or '').upper()
    if c == 'VEHICLE INTO BARRIER':
        return 'frontal'
    if c == 'VEHICLE INTO POLE':
        return 'pole'
    if c == 'IMPACTOR INTO VEHICLE':
        return 'rear' if angle == 180 else 'side' if angle in (90, 270) else None
    return None


def struck_side(angle):
    """NHTSA's impact angle: 270 (and 255-285) = the left side is struck, 90 = the right side."""
    if angle is None:
        return None
    a = int(angle) % 360
    return 'left' if 240 <= a <= 300 else 'right' if 60 <= a <= 120 else None


def post_order(kind, struck):
    """Views after the test, best first, for the test's kind."""
    s = struck
    if kind == 'frontal':
        return ['front_34_left', 'front_34_right', 'front_34', 'front', 'side_left', 'side_right']
    if kind in ('side', 'pole'):
        # The struck side unknown: no view after the test, rather than a guess at which side shows the damage.
        return [f'side_{s}', f'front_34_{s}', f'rear_34_{s}', 'side'] if s in ('left', 'right') else []
    if kind == 'rear':
        return ['rear_34_left', 'rear_34_right', 'rear_34', 'rear']
    return []


def choose(photos, kind, struck):
    """Photos kept for one test, in display order: [{'file', 'name', 'phase', 'view', 'web'}...].

    photos: the listing's [{'file': 'v10000P006.jpg', 'name': originalFileName, ...}]."""
    rows = []
    for i, p in enumerate(photos):
        c = classify(p.get('name'))
        if c:
            rows.append({**p, **c, '_i': i})
    pre = sorted((r for r in rows if r['phase'] == 'pre'), key=lambda r: (PRE_ORDER.index(r['view']), not r['web'], r['_i']))
    out, groups = [], set()
    for r in pre:
        g = VIEW_GROUP[r['view']]
        if g in groups:
            continue
        groups.add(g)
        out.append(r)
        if len(out) == PRE_MAX:
            break
    if kind:
        order = post_order(kind, struck)
        post = sorted((r for r in rows if r['phase'] == 'post' and r['view'] in order), key=lambda r: (order.index(r['view']), r['_i']))
        if post:
            out.append(post[0])
    return [{k: v for k, v in r.items() if k != '_i'} for r in out]
