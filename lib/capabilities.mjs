export const capabilities = [
  {
    "feature": "VIN decode",
    "status": "partial",
    "detail": "NHTSA vPIC, VIN validation, 140+ raw fields; no claim of universal global coverage.",
    "endpoint": "/api/vin/{vin}"
  },
  {
    "feature": "Decode checks",
    "status": "conditional",
    "detail": "Field-by-field checks on the vPIC decode: the manufacturer's own description of the VIN where its recall lookup returns one (VW, Audi, Land Rover, Jaguar, Subaru, Honda/Acura), NHTSA lab records of 2,418 test vehicles in 1,643 VIN patterns, and EPA configurations for the model year. Corrected, doubtful or filled values are marked with vPIC's value kept; 'Report a decode error' goes to review only.",
    "endpoint": "/api/vin/{vin}"
  },
  {
    "feature": "Plate-to-VIN",
    "status": "gap",
    "detail": "No verified reusable free US lookup source. NHTSA has an interactive plate recall lookup, not our plate API.",
    "endpoint": null
  },
  {
    "feature": "Specifications",
    "status": "partial",
    "detail": "vPIC plus EPA configurations and Canadian dimensions; equipment availability is not a factory build sheet.",
    "endpoint": "/api/research/dimensions"
  },
  {
    "feature": "EPA test vehicles",
    "status": "conditional",
    "detail": "EPA Test Car List 1998-2026: rated horsepower, transmission, axle ratios and test weight of the manufacturer's certification test vehicles for the engine family, matched by EPA test group or labelled closest configuration; not this car's build. Requires installed index.",
    "endpoint": "/api/vin/{vin}"
  },
  {
    "feature": "Parts content and origin",
    "status": "conditional",
    "detail": "NHTSA Part 583 (AALA) reports, model years 2020-2027: US/Canadian parts content, other major source countries, final assembly, engine and transmission origin for the carline, narrowed by drive and plant country; every fitting version listed, carline-level, not this car. Requires installed index.",
    "endpoint": "/api/vin/{vin}"
  },
  {
    "feature": "Production and theft (historical)",
    "status": "conditional",
    "detail": "NHTSA final theft data, model years 1998-2010 and 2012: the vehicle line's production as reported to the EPA, thefts in the same calendar year, thefts per 1,000 produced and rank; whole-line figures, closest line names disclosed. Requires installed index.",
    "endpoint": "/api/vin/{vin}"
  },
  {
    "feature": "OEM build data",
    "status": "gap",
    "detail": "Exact factory options, paint and option MSRP need a verified manufacturer source; not inferred.",
    "endpoint": null
  },
  {
    "feature": "Vehicle listings",
    "status": "gap",
    "detail": "No nationwide free inventory feed verified. EPA catalog is specifications, not cars for sale.",
    "endpoint": null
  },
  {
    "feature": "Vehicle photos",
    "status": "partial",
    "detail": "Existing representative stock images retained; no exact-VIN listing photo coverage.",
    "endpoint": "/api/vin/{vin}/photo"
  },
  {
    "feature": "Interest rates",
    "status": "partial",
    "detail": "Dated Federal Reserve new-car benchmark snapshot with observation/release dates; no personalized lender rate.",
    "endpoint": "/api/research/rate-benchmarks"
  },
  {
    "feature": "Payments",
    "status": "partial",
    "detail": "Working fixed-rate amortization with editable assumptions, no lender offer.",
    "endpoint": "/api/research/scenario"
  },
  {
    "feature": "Taxes and fees",
    "status": "gap",
    "detail": "User-supplied amounts supported; automatic jurisdiction-specific calculation not implemented.",
    "endpoint": null
  },
  {
    "feature": "Ownership cost",
    "status": "partial",
    "detail": "Transparent scenario including depreciation, energy, insurance, repairs, maintenance and interest; no predicted resale or repair quotes.",
    "endpoint": "/api/research/scenario"
  },
  {
    "feature": "Recall campaigns",
    "status": "available",
    "detail": "NHTSA model-year campaigns, with the manufacturer's build-date range per campaign from NHTSA's recall flat file when indexed; does not establish VIN-specific applicability.",
    "endpoint": "/api/vin/{vin}/recalls"
  },
  {
    "feature": "VIN recall repair status",
    "status": "partial",
    "detail": "Tesla and Ford open/completed status; GM open/completed or administratively closed records, with explicit repair dates where supplied; Honda and Acura active safety recalls (15-year lookback); Subaru completed/incomplete safety recalls with emissions campaigns separate; Volkswagen, Audi, Land Rover and Jaguar recalls as reported by each maker (completed repairs unknown unless returned); positive VIN-matched Nissan open safety recalls; VIN-matched Mopar fleet open recall/campaign records. Other programs stay separate. Honda/Nissan/Mopar completed history is unknown. Toyota/Lexus/Scion, Hyundai and Kia require interactive official verification.",
    "endpoint": "/api/vin/{vin}/recall-status"
  },
  {
    "feature": "Vehicle comparisons",
    "status": "available",
    "detail": "Compare up to four VIN reports with partial failures visible.",
    "endpoint": "/api/research/compare"
  },
  {
    "feature": "EPA catalog and emissions",
    "status": "available",
    "detail": "Browse explicit test configurations, MPG/MPGe, electricity consumption, emissions and price assumptions.",
    "endpoint": "/api/research/catalog/{level}"
  },
  {
    "feature": "Manufacturer communications",
    "status": "conditional",
    "detail": "Free NHTSA archive index; available when index is installed. Coverage and download timestamps included.",
    "endpoint": "/api/research/communications"
  },
  {
    "feature": "Developer access",
    "status": "available",
    "detail": "Existing REST and MCP preserved; new research tools, JavaScript client and local CLI added.",
    "endpoint": "/api/research/capabilities"
  },
  {
    "feature": "Owner-reported MPG",
    "status": "available",
    "detail": "Voluntary FuelEconomy.gov reports, sample size and harmonic mean; not representative or VIN-specific.",
    "endpoint": "/api/research/epa/{id}/owner-mpg"
  },
  {
    "feature": "Defect investigations",
    "status": "conditional",
    "detail": "Official NHTSA snapshot with distinct report variants, dates and linked recall campaign IDs. Requires installed index.",
    "endpoint": "/api/research/investigations"
  }
];
