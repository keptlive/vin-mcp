"""Build the dated professional comparison sheets; requires reportlab and pypdf."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from pypdf import PdfReader, PdfWriter

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'public/research/sheets'
OUT.mkdir(parents=True,exist_ok=True)
INK=colors.HexColor('#17243B'); MUTED=colors.HexColor('#475569'); LINE=colors.HexColor('#D8DEE8'); ACCENT=colors.HexColor('#494C96')
styles={
 'title':ParagraphStyle('title',fontName='Helvetica-Bold',fontSize=24,leading=28,textColor=INK,spaceAfter=10),
 'deck':ParagraphStyle('deck',fontName='Helvetica',fontSize=10,leading=14,textColor=MUTED,spaceAfter=12),
 'body':ParagraphStyle('body',fontName='Helvetica',fontSize=9,leading=12,textColor=INK),
 'small':ParagraphStyle('small',fontName='Helvetica',fontSize=8,leading=10.5,textColor=MUTED),
 'head':ParagraphStyle('head',fontName='Helvetica-Bold',fontSize=11,leading=14,textColor=INK,spaceBefore=13,spaceAfter=7),
 'cell':ParagraphStyle('cell',fontName='Helvetica',fontSize=8.6,leading=11.2,textColor=INK),
 'th':ParagraphStyle('th',fontName='Helvetica-Bold',fontSize=8.5,leading=11,textColor=colors.white),
}
def p(t,s='body'):return Paragraph(t,styles[s])
def table(headers,rows,widths):
 t=Table([[p(x,'th') for x in headers]]+[[p(x,'cell') for x in r] for r in rows],colWidths=widths,repeatRows=1,hAlign='LEFT')
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,1),(-1,-1),.4,LINE),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F3F5F9')])]))
 return t
def chrome(canvas,doc):
 canvas.saveState();canvas.setFillColor(ACCENT);canvas.rect(42,749,528,3,fill=1,stroke=0)
 canvas.setFont('Helvetica-Bold',9);canvas.setFillColor(INK);canvas.drawString(42,764,'mcp.vin  /  PROFESSIONAL BRIEF')
 canvas.setFont('Helvetica',8);canvas.drawRightString(570,764,'24 OCTOBER 2026')
 canvas.setStrokeColor(LINE);canvas.line(42,39,570,39)
 canvas.setFillColor(MUTED);canvas.setFont('Helvetica',7.5);canvas.drawString(42,26,'RELEASE 1.4.0  |  Public-source vehicle research')
 sheet='01' if doc.subject=='Capability comparison' else '02'
 canvas.drawRightString(570,26,doc.subject+'  /  SHEET '+sheet);canvas.restoreState()
def build(name,title,story):
 target=OUT/name
 doc=SimpleDocTemplate(str(target),pagesize=(612,792),rightMargin=42,leftMargin=42,topMargin=56,bottomMargin=50,title=title,author='mcp.vin',subject=title)
 doc.build(story,onFirstPage=chrome,onLaterPages=chrome)
 assert len(PdfReader(target).pages)==1, f'{name} must fit one information sheet'
 return target

comparison=[
 ['VIN decoding','Global VIN decode','<b>Partial.</b> NHTSA vPIC decoding and validation; US-oriented coverage.'],
 ['Specifications','VIN-based specifications','<b>Partial.</b> vPIC fields, EPA configurations and Canadian dimensions.'],
 ['Factory equipment','OEM build data','<b>Gap.</b> Exact factory options, paint and option pricing are not verified.'],
 ['Plate lookup','Plate-to-VIN','<b>Gap.</b> No verified free nationwide source integrated.'],
 ['Inventory','Vehicle listings','<b>Gap.</b> No nationwide inventory feed integrated.'],
 ['Photography','Vehicle photos','<b>Partial.</b> Representative stock images; no exact-VIN photo coverage.'],
 ['Interest rates','APR endpoint','<b>Partial.</b> Dated Federal Reserve benchmark; no personalized quote.'],
 ['Loan payments','Payment calculations','<b>Partial.</b> Amortization from entered APR, taxes, fees and term.'],
 ['Taxes and fees','Tax and fee endpoint','<b>Gap.</b> Entered amounts only; no jurisdiction-specific lookup.'],
 ['Ownership costs','Ownership-cost endpoint','<b>Partial.</b> Editable cost scenarios; no resale or repair-cost prediction.'],
 ['Recall campaigns','Recall endpoint','<b>Partial.</b> Model-year NHTSA campaigns; VIN applicability unconfirmed.'],
 ['Unrepaired recalls','Open-recall endpoint','<b>Partial.</b> Tesla open/completed status; Mopar open campaign records. Toyota requires interactive verification.'],
 ['Developer access','REST, MCP, CLI, SDK','<b>Implemented.</b> REST, 22 MCP tools, local JavaScript client and CLI.'],
]
first=build('capability-comparison.pdf','Capability comparison',[
 p('Automotive data capabilities','title'),
 p('auto.dev and mcp.vin | Scope of available data and developer access','deck'),
 p('auto.dev entries reflect its public product descriptions. mcp.vin entries reflect the verified release 1.4.0. This is a scope comparison, not a test of relative accuracy, coverage or service performance.','small'),Spacer(1,12),
 table(['Capability','auto.dev advertises [1]','mcp.vin implementation [2]'],comparison,[101,126,301]),Spacer(1,10),
 p('<b>Assessment:</b> mcp.vin supports public-data research and transparent cost modeling. It does not yet replace auto.dev across factory build data, inventory, plate lookup or universal VIN recall repair status.','body'),Spacer(1,8),
 p('[1] auto.dev product catalog: <link href="https://www.auto.dev/" color="#494C96">www.auto.dev</link>; specifications, OEM build and open-recall product pages. Reviewed 24 Oct 2026. Advertised capabilities were not independently benchmarked.<br/>[2] Source: release 1.4.0; source review dated 24 Oct 2026. Partial = narrower scope. Gap = required data not integrated. Implemented does not imply identical data coverage.','small')])

sources=[
 ['NHTSA vPIC [1]','VIN decoding and submitted vehicle attributes','US-oriented manufacturer records; completeness varies by vehicle.'],
 ['EPA / FuelEconomy.gov [2]','Configurations, emissions, energy assumptions and owner MPG','Test configuration data. Owner reports are voluntary; sample size and method are shown.'],
 ['Transport Canada via vPIC [1]','Dimensions and curb mass','Canadian model variants. Select the appropriate configuration; not an exact-VIN match.'],
 ['NHTSA ODI archives [3]','Manufacturer communications and defect investigations','Dated local indexes. Report variants and provenance retained; not a vehicle-level defect finding.'],
 ['Federal Reserve G.19 [4]','New-car loan rate context','Manual snapshot: Aug 2026 observations, released 7 Oct 2026. Not a lender offer.'],
]
second=build('data-and-methodology.pdf','Data and methodology',[
 p('Data sources and methodology','title'),p('mcp.vin | Evidence, coverage and appropriate use','deck'),
 table(['Primary source','Implemented use','Interpretation'],sources,[117,183,228]),
 p('Verified implementation','head'),
 p('<b>80 application tests</b> and two index integrity tests passed. Live checks exercised REST, the JavaScript client and MCP. The interface was reviewed on desktop and at 390-pixel width. This is implementation verification, not an independent accuracy certification.'),
 p('Investigation index: <b>5,351 distinct actions</b> across 154,439 association rows. The manufacturer-communications index contains 5,834,958 vehicle/component associations across seven archives; that is not a count of unique bulletins.'),
 p('Illustrative source check','head'),
 p('2003 Honda Accord V6 automatic, EPA ID 18657: <b>22 combined EPA MPG</b>; <b>23.5 owner-reported harmonic mean MPG</b> from 29 submitted records, range 15-34 MPG. These measures use different methods and samples. The Honda Accord 2003 investigation query returned five distinct actions. Values reflect the 24 Oct 2026 UTC verification.'),
 p('Professional use','head'),
 p('<b>Confirm the configuration.</b> Model-year records do not establish exact factory equipment.<br/><b>Check recall status separately.</b> Campaigns and investigations do not establish applicability or repair completion for a VIN.<br/><b>Review assumptions and dates.</b> Cost results use entered assumptions; source snapshots and rate benchmarks can become outdated.'),
 p('Sources and verification basis','head'),
 p('[1] <link href="https://vpic.nhtsa.dot.gov/api/" color="#494C96">vpic.nhtsa.dot.gov/api/</link><br/>[2] <link href="https://www.fueleconomy.gov/feg/ws/" color="#494C96">fueleconomy.gov/feg/ws/</link><br/>[3] <link href="https://www.nhtsa.gov/nhtsa-datasets-and-apis" color="#494C96">nhtsa.gov/nhtsa-datasets-and-apis</link><br/>[4] <link href="https://www.federalreserve.gov/releases/g19/20261007/" color="#494C96">federalreserve.gov/releases/g19/20261007/</link><br/>Source reference: docs/data-sources.md; verified release 1.4.0. No paid data provider is required for these research features. Hosting, maintenance and source availability remain operational considerations.','small')])
writer=PdfWriter()
for path in [first,second]:writer.append(str(path))
writer.add_metadata({'/Title':'mcp.vin - Professional comparison and data brief','/Author':'mcp.vin'})
with (OUT/'professional-brief.pdf').open('wb') as stream:writer.write(stream)
print('Created three PDFs: two standalone sheets and one combined two-page brief.')
