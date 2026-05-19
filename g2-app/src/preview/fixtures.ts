// Snapshot fixtures for the screens-gallery preview. Each exported
// const is a hand-crafted state that exercises a specific code path
// or visual contract. The gallery composer (`gallery.ts`) imports
// these, calls each screen's `view()`, and renders the result.
//
// All fixtures use the same canonical `NOW` timestamp so renders
// are deterministic across reloads.

import type { Train, RailIncident, ElevatorIncident, PathStep } from '../wmata';
import type { HomeSnapshot } from '../screens/home';
import type { PredictionsSnapshot } from '../screens/predictions';
import type { IncidentsSnapshot } from '../screens/incidents';
import type { ElevatorSnapshot } from '../screens/elevator';
import type { JourneySnapshot } from '../screens/journey';
import type { VoiceSnapshot } from '../screens/voice';
import { formatIncidentBlock as fmtRailIncidentBlock } from '../screens/incidents';
import { formatIncidentBlock as fmtElevatorBlock } from '../screens/elevator';

/** Canonical wall clock for every fixture render. May 18 2026, 14:32 local. */
export const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();
/** Evening clock for fixtures that show the late-train row. */
export const EVENING = new Date(2026, 4, 18, 22, 30, 0).getTime();

// ---------------------------------------------------------------------------
// Favorites used across Home / Voice fixtures
// ---------------------------------------------------------------------------

const FAV_METRO_CENTER = {
  code: 'A01',
  name: 'Metro Center',
  lines: ['RD', 'BL', 'OR', 'SV'] as const,
};
const FAV_GALLERY_PL = {
  code: 'B01',
  name: 'Gallery Pl-Chinatown',
  lines: ['RD', 'YL', 'GR'] as const,
};
const FAV_UNION_STN = {
  code: 'B03',
  name: 'Union Station',
  lines: ['RD'] as const,
};
const FAV_FOGGY_BTM = {
  code: 'C04',
  name: 'Foggy Bottom-GWU',
  lines: ['BL', 'OR', 'SV'] as const,
};
const FAV_LENFANT = {
  code: 'D03',
  name: "L'Enfant Plaza",
  lines: ['BL', 'OR', 'YL', 'GR'] as const,
};

// ---------------------------------------------------------------------------
// HomeSnapshot fixtures
// ---------------------------------------------------------------------------

export const HOME_EMPTY: HomeSnapshot = {
  favorites: [],
  affectedLines: [],
  accessOutageCount: 0,
  quietHours: false,
};

export const HOME_THREE_FAVS: HomeSnapshot = {
  favorites: [
    { ...FAV_METRO_CENTER, lines: [...FAV_METRO_CENTER.lines] },
    { ...FAV_GALLERY_PL, lines: [...FAV_GALLERY_PL.lines] },
    { ...FAV_UNION_STN, lines: [...FAV_UNION_STN.lines] },
  ],
  affectedLines: [],
  accessOutageCount: 0,
  quietHours: false,
};

export const HOME_WITH_ALERTS: HomeSnapshot = {
  ...HOME_THREE_FAVS,
  affectedLines: ['RD', 'OR'],
};

export const HOME_WITH_ALERTS_AND_ACCESS: HomeSnapshot = {
  ...HOME_THREE_FAVS,
  affectedLines: ['RD', 'OR'],
  accessOutageCount: 2,
};

export const HOME_QUIET_HOURS: HomeSnapshot = {
  ...HOME_THREE_FAVS,
  affectedLines: ['RD', 'OR'],
  accessOutageCount: 2,
  quietHours: true,
};

export const HOME_FIVE_FAVS: HomeSnapshot = {
  favorites: [
    { ...FAV_METRO_CENTER, lines: [...FAV_METRO_CENTER.lines] },
    { ...FAV_GALLERY_PL, lines: [...FAV_GALLERY_PL.lines] },
    { ...FAV_UNION_STN, lines: [...FAV_UNION_STN.lines] },
    { ...FAV_FOGGY_BTM, lines: [...FAV_FOGGY_BTM.lines] },
    { ...FAV_LENFANT, lines: [...FAV_LENFANT.lines] },
  ],
  affectedLines: [],
  accessOutageCount: 0,
  quietHours: false,
};

// ---------------------------------------------------------------------------
// PredictionsSnapshot fixtures
// ---------------------------------------------------------------------------

function mkTrain(over: Partial<Train>): Train {
  return {
    Car: '6',
    Destination: 'Shady Grove',
    DestinationCode: null,
    DestinationName: 'Shady Grove',
    Group: '1',
    Line: 'RD',
    LocationCode: 'A01',
    LocationName: 'Metro Center',
    Min: '5',
    ...over,
  };
}

const PRED_BASE: PredictionsSnapshot = {
  stationCode: 'A01',
  stationName: 'Metro Center',
  trains: [],
  fetchedAt: NOW,
  fetchError: null,
  consecutiveFetchFailures: 0,
  incidentHeadline: null,
  lastTrainToday: null,
  pinned: null,
  pinnedPosition: null,
  cursorVisible: false,
  pinnedGone: false,
};

export const PRED_LOADING: PredictionsSnapshot = {
  ...PRED_BASE,
  trains: [],
  fetchedAt: 0,
};

export const PRED_THREE_TRAINS: PredictionsSnapshot = {
  ...PRED_BASE,
  trains: [
    mkTrain({ Line: 'RD', Destination: 'Shady Grove', Car: '6', Min: 'ARR' }),
    mkTrain({ Line: 'RD', Destination: 'Glenmont', Car: '8', Min: '3' }),
    mkTrain({ Line: 'OR', Destination: 'Vienna', Car: '6', Min: '5' }),
  ],
};

export const PRED_WITH_CURSOR: PredictionsSnapshot = {
  ...PRED_THREE_TRAINS,
  cursorVisible: true,
};

export const PRED_PINNED: PredictionsSnapshot = {
  ...PRED_THREE_TRAINS,
  cursorVisible: true,
  pinned: { line: 'RD', destination: 'Glenmont' },
};

export const PRED_PINNED_WITH_POSITION: PredictionsSnapshot = {
  ...PRED_PINNED,
  pinnedPosition: {
    label: '* RD 3 stops away',
    schematic: 'RD -*--@--------------',
  },
};

export const PRED_PINNED_GONE: PredictionsSnapshot = {
  ...PRED_BASE,
  trains: [
    mkTrain({ Line: 'RD', Destination: 'Shady Grove', Car: '6', Min: 'ARR' }),
    mkTrain({ Line: 'OR', Destination: 'Vienna', Car: '6', Min: '5' }),
  ],
  pinned: { line: 'RD', destination: 'Glenmont' },
  pinnedGone: true,
};

export const PRED_WITH_INCIDENT: PredictionsSnapshot = {
  ...PRED_THREE_TRAINS,
  incidentHeadline: 'Single-tracking on RD between Foggy Bottom',
};

export const PRED_STALE_TWO_FAILURES: PredictionsSnapshot = {
  ...PRED_THREE_TRAINS,
  consecutiveFetchFailures: 2,
  fetchError: 'Network slow',
};

export const PRED_FETCH_ERROR_NO_DATA: PredictionsSnapshot = {
  ...PRED_BASE,
  fetchedAt: 0,
  fetchError: 'Could not reach WMATA.',
  consecutiveFetchFailures: 1,
};

export const PRED_LATE_NIGHT: PredictionsSnapshot = {
  ...PRED_THREE_TRAINS,
  lastTrainToday: [
    { line: 'OR', time: '22:50' },
    { line: 'RD', time: '23:47' },
  ],
};

// ---------------------------------------------------------------------------
// IncidentsSnapshot fixtures
// ---------------------------------------------------------------------------

function mkRailIncident(over: Partial<RailIncident>): RailIncident {
  return {
    IncidentID: 'id-1',
    Description: 'Single-tracking between Foggy Bottom and Rosslyn.',
    IncidentType: 'Delay',
    LinesAffected: 'BL; OR; SV;',
    DateUpdated: '2026-05-18T14:30:00',
    ...over,
  };
}

const INCIDENT_BASE = {
  fetchedAt: NOW,
  fetchError: null as string | null,
  consecutiveFetchFailures: 0,
};

export const INCIDENTS_EMPTY: IncidentsSnapshot = {
  incidents: [],
  ...INCIDENT_BASE,
  preformatted: [],
};

const SINGLE_INCIDENT = mkRailIncident({});
export const INCIDENTS_ONE: IncidentsSnapshot = {
  incidents: [SINGLE_INCIDENT],
  ...INCIDENT_BASE,
  preformatted: [fmtRailIncidentBlock(SINGLE_INCIDENT)],
};

const THREE_INCIDENTS = [
  mkRailIncident({
    IncidentID: 'a',
    LinesAffected: 'RD;',
    Description:
      'Trains single-tracking between Tenleytown and Bethesda due to a disabled train.',
  }),
  mkRailIncident({
    IncidentID: 'b',
    LinesAffected: 'BL; OR; SV;',
    Description:
      'Trains experiencing delays approaching Foggy Bottom while crews respond.',
  }),
  mkRailIncident({
    IncidentID: 'c',
    LinesAffected: 'YL;',
    Description: 'Trains operating on a holiday schedule.',
  }),
];
export const INCIDENTS_THREE: IncidentsSnapshot = {
  incidents: THREE_INCIDENTS,
  ...INCIDENT_BASE,
  preformatted: THREE_INCIDENTS.map(fmtRailIncidentBlock),
};

export const INCIDENTS_FETCH_ERROR: IncidentsSnapshot = {
  incidents: [],
  fetchedAt: 0,
  fetchError: 'Could not connect.',
  consecutiveFetchFailures: 1,
  preformatted: [],
};

// ---------------------------------------------------------------------------
// ElevatorSnapshot fixtures
// ---------------------------------------------------------------------------

function mkElevatorIncident(over: Partial<ElevatorIncident>): ElevatorIncident {
  return {
    DateOutOfServ: '2026-05-18T13:00:00',
    DateUpdated: '2026-05-18T14:30:00',
    EstimatedReturnToService: null,
    LocationDescription: 'Mezzanine to street, west side.',
    StationCode: 'A03',
    StationName: 'Dupont Circle',
    SymptomDescription: 'Service Call',
    UnitName: 'A03N04',
    UnitType: 'ELEVATOR',
    ...over,
  };
}

const ELEVATOR_BASE = {
  fetchedAt: NOW,
  fetchError: null as string | null,
  consecutiveFetchFailures: 0,
};

export const ELEVATOR_EMPTY: ElevatorSnapshot = {
  incidents: [],
  ...ELEVATOR_BASE,
  preformatted: [],
};

const TWO_OUTAGES = [
  mkElevatorIncident({
    UnitType: 'ELEVATOR',
    StationName: 'Foggy Bottom-GWU',
    LocationDescription: 'Street to mezzanine.',
  }),
  mkElevatorIncident({
    UnitType: 'ESCALATOR',
    StationName: 'Dupont Circle, Q Street Entrance',
    LocationDescription: 'Mezzanine to platform, west side.',
  }),
];
export const ELEVATOR_TWO: ElevatorSnapshot = {
  incidents: TWO_OUTAGES,
  ...ELEVATOR_BASE,
  preformatted: TWO_OUTAGES.map(fmtElevatorBlock),
};

// ---------------------------------------------------------------------------
// JourneySnapshot fixtures
// ---------------------------------------------------------------------------

function mkPathStep(over: Partial<PathStep>): PathStep {
  return {
    DistanceToPrev: 0,
    LineCode: 'RD',
    SeqNum: 1,
    StationCode: 'A01',
    StationName: 'Metro Center',
    ...over,
  };
}

export const JOURNEY_UNCONFIGURED: JourneySnapshot = {
  plan: { origin: '', destination: '', transfer: '' },
  originName: '',
  destinationName: '',
  transferName: '',
  legs: null,
  nextTrain: null,
  fetchedAt: 0,
  fetchError: null,
};

export const JOURNEY_LOADING: JourneySnapshot = {
  plan: { origin: 'C01', destination: 'C04', transfer: '' },
  originName: 'Metro Center',
  destinationName: 'Foggy Bottom-GWU',
  transferName: '',
  legs: null,
  nextTrain: null,
  fetchedAt: 0,
  fetchError: null,
};

const SAME_LINE_LEG = [
  mkPathStep({ SeqNum: 1, StationCode: 'C01', LineCode: 'BL' }),
  mkPathStep({ SeqNum: 2, StationCode: 'C02', LineCode: 'BL' }),
  mkPathStep({ SeqNum: 3, StationCode: 'C03', LineCode: 'BL' }),
  mkPathStep({ SeqNum: 4, StationCode: 'C04', LineCode: 'BL' }),
];
export const JOURNEY_SAME_LINE: JourneySnapshot = {
  plan: { origin: 'C01', destination: 'C04', transfer: '' },
  originName: 'Metro Center',
  destinationName: 'Foggy Bottom-GWU',
  transferName: '',
  legs: [SAME_LINE_LEG],
  nextTrain: { line: 'BL', min: '5', destination: 'Franc-Spr' },
  fetchedAt: NOW,
  fetchError: null,
};

const LEG_A = [
  mkPathStep({ SeqNum: 1, StationCode: 'C01', LineCode: 'OR' }),
  mkPathStep({ SeqNum: 2, StationCode: 'C02', LineCode: 'OR' }),
  mkPathStep({ SeqNum: 3, StationCode: 'D03', LineCode: 'OR' }),
];
const LEG_B = [
  mkPathStep({ SeqNum: 1, StationCode: 'D03', LineCode: 'YL' }),
  mkPathStep({ SeqNum: 2, StationCode: 'F01', LineCode: 'YL' }),
  mkPathStep({ SeqNum: 3, StationCode: 'F02', LineCode: 'YL' }),
];
export const JOURNEY_TWO_LEG: JourneySnapshot = {
  plan: { origin: 'C01', destination: 'F02', transfer: 'D03' },
  originName: 'Metro Center',
  destinationName: 'Pentagon City',
  transferName: "L'Enfant Plaza",
  legs: [LEG_A, LEG_B],
  nextTrain: { line: 'OR', min: '3', destination: 'New Carr' },
  fetchedAt: NOW,
  fetchError: null,
};

export const JOURNEY_NOT_ROUTABLE: JourneySnapshot = {
  plan: { origin: 'C01', destination: 'F02', transfer: '' },
  originName: 'Metro Center',
  destinationName: 'Pentagon City',
  transferName: '',
  legs: [],
  nextTrain: null,
  fetchedAt: NOW,
  fetchError: null,
};

// ---------------------------------------------------------------------------
// VoiceSnapshot fixtures
// ---------------------------------------------------------------------------

export const VOICE_LISTENING: VoiceSnapshot = {
  transcript: 'metro c',
  phase: 'listening',
  matches: [],
  matchIndex: 0,
  errorMessage: null,
  lastQuery: '',
};

export const VOICE_RESOLVING: VoiceSnapshot = {
  transcript: 'metro center',
  phase: 'resolving',
  matches: [],
  matchIndex: 0,
  errorMessage: null,
  lastQuery: 'metro center',
};

export const VOICE_MATCHES: VoiceSnapshot = {
  transcript: 'metro',
  phase: 'matches',
  matches: [
    {
      Code: 'A01',
      Name: 'Metro Center',
      LineCode1: 'RD',
      LineCode2: 'BL',
      LineCode3: 'OR',
      LineCode4: 'SV',
      Lat: 0,
      Lon: 0,
      StationTogether1: '',
      StationTogether2: '',
      Address: { City: '', State: '', Street: '', Zip: '' },
    },
    {
      Code: 'F03',
      Name: 'Pentagon',
      LineCode1: 'BL',
      LineCode2: 'YL',
      LineCode3: null,
      LineCode4: null,
      Lat: 0,
      Lon: 0,
      StationTogether1: '',
      StationTogether2: '',
      Address: { City: '', State: '', Street: '', Zip: '' },
    },
  ],
  matchIndex: 0,
  errorMessage: null,
  lastQuery: 'metro',
};

export const VOICE_NO_MATCH: VoiceSnapshot = {
  transcript: 'pumpkin spice',
  phase: 'noMatch',
  matches: [],
  matchIndex: 0,
  errorMessage: null,
  lastQuery: 'pumpkin spice',
};

export const VOICE_ERROR: VoiceSnapshot = {
  transcript: '',
  phase: 'error',
  matches: [],
  matchIndex: 0,
  errorMessage: 'Microphone unavailable.',
  lastQuery: '',
};
