import { MatDateFormats } from '@angular/material/core';

export const appSettings = {
  appTitle: 'Tanstack Start TS',
  credentialsKey: 'demo_admin_user',
  rememberKey: 'demo_admin_remember',
  rowsPerPage: 10,
  ajaxTimeout: 300000,
  mobilePattern: /^[\d()+-]+$/,
  number: /^\d+$/,
  otpTime: 60,
  whitespacePattern: /^(?! *$)[\s\S]+$/,
  emailPattern:
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\])|(([a-zA-Z\-\d]+\.)+[a-zA-Z]{2,}))$/,
  stringFilterDropdown: [
    { value: 'startsWith', label: 'Starts With' },
    { value: 'endsWith', label: 'Ends With' },
    { value: 'contains', label: 'Contains' },
    { value: 'notContains', label: 'Not Contains' },
    { value: 'equals', label: 'Equals' },
    { value: 'notEquals', label: 'Not Equals' },
  ],
  dateFilterDropdown: [
    { value: 'dateIs', label: 'Date is' },
    { value: 'dateIsNot', label: 'Date is not' },
    { value: 'dateIsBefore', label: 'Date is before' },
    { value: 'dateIsAfter', label: 'Date is after' },
  ],
  numberFilterDropDown: [
    { value: 'equals', label: 'Equal' },
    { value: 'notEquals', label: 'Not equal' },
    { value: 'lt', label: 'Less than' },
    { value: 'lte', label: 'Less or equal' },
    { value: 'gt', label: 'Greater than' },
    { value: 'gte', label: 'Greater or equal' },
  ],

  customDateFormate: {
    parse: {
      dateInput: 'DD/MM/YYYY',
    },
    display: {
      dateInput: 'DD/MM/YYYY',
      monthYearLabel: 'DD/MM/YYYY',
      dateA11yLabel: 'LL',
      monthYearA11yLabel: 'DD/MM/YYYY',
    },
  },
  //per page row number array
  rowsPerPageNumbers: [{ value: 5 }, { value: 10 }, { value: 15 }, { value: 20 }, { value: 25 }],

  ratingRuleList: [
    {
      name: 'Equal to',
      sign: '==',
    },
    {
      name: 'Greater than or equal to',
      sign: '>=',
    },
    {
      name: 'Less than or equal to',
      sign: '<=',
    },
    {
      name: 'Greater than',
      sign: '>',
    },
    {
      name: 'Less than',
      sign: '<',
    },
  ],

  actonRequiredList: [
    {
      action_name: 'Action must be taken',
      action_id: 1,
    },
    {
      action_name: 'Action is recommended',
      action_id: 2,
    },
    {
      action_name: 'Action not required',
      action_id: 3,
    },
  ],

  actionRulesList: [
    {
      action_rule_id: 1,
      name: 'Equal to',
      sign: '==',
    },
    {
      action_rule_id: 2,
      name: 'Not equal to',
      sign: '!=',
    },
    {
      action_rule_id: 3,
      name: 'Greater than or equal to',
      sign: '>=',
    },
    {
      action_rule_id: 4,
      name: 'Less than or equal to',
      sign: '<=',
    },
    {
      action_rule_id: 5,
      name: 'Greater than',
      sign: '>',
    },
    {
      action_rule_id: 6,
      name: 'Less than',
      sign: '<',
    },
  ],

  complianceTypes: [
    {
      compliance_type_id: 1,
      compliance_type_name: 'Compliant',
    },
    {
      compliance_type_id: 2,
      compliance_type_name: 'Not Compliant',
    },
    {
      compliance_type_id: 3,
      compliance_type_name: 'Not Applicable',
    },
  ],
  complianceColorPalate: [
    {
      compliance_type_id: 1,
      compliance_type_name: 'Compliant',
    },
    {
      compliance_type_id: 2,
      compliance_type_name: 'Not Compliant',
    },
    {
      compliance_type_id: 3,
      compliance_type_name: 'N/A',
    },
    {
      compliance_type_id: 4,
      compliance_type_name: 'Action Required',
    },
    {
      compliance_type_id: 5,
      compliance_type_name: 'Not Answered',
    },
  ],

  questionTypesList: [
    {
      question_type_id: 1,
      question_type_name: 'ActionlessYesNo',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Yes',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'No',
            action_required: 3,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 2,
      question_type_name: 'Compliant',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Compliant',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'Not Compliant',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 3,
      question_type_name: 'Date',
      inputs: {
        type: 'datepicker',
        options: [],
        extras: {},
      },
    },
    {
      question_type_id: 4,
      question_type_name: 'Dropdown',
      inputs: {
        type: 'dropdown',
        options: [],
        extras: {
          action_required: true,
          compliance_type: true,
          score: true,
          action_rule: false,
          options: true,
        },
      },
    },
    {
      question_type_id: 5,
      question_type_name: 'MultiAnswer',
      inputs: {
        type: 'textarea',
        options: [],
        extras: {},
      },
    },
    {
      question_type_id: 6,
      question_type_name: 'NumericInput',
      inputs: {
        type: 'numeric',
        options: [],
        extras: {
          action_required: true,
          compliance_type: false,
          score: false,
          action_rule: true,
          options: false,
        },
      },
    },
    {
      question_type_id: 7,
      question_type_name: 'PcCompliance',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Fully met',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'Partially met',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
          {
            label: 'Not met',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'amber',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 8,
      question_type_name: 'RadioRAG',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Green',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'Amber',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'amber',
          },
          {
            label: 'Red',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
          {
            label: 'N/A',
            action_required: 3,
            action_rule: false,
            score: 'Not Applicable',
            color: 'sky',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 9,
      question_type_name: 'Text',
      inputs: {
        type: 'textbox',
        options: [],
        extras: {
          action_required: false,
          compliance_type: false,
          score: false,
          action_rule: false,
          options: false,
        },
      },
    },
    {
      question_type_id: 10,
      question_type_name: 'TimePicker',
      inputs: {
        type: 'timepicker',
        options: [],
        extras: {
          action_required: false,
          compliance_type: false,
          score: false,
          action_rule: false,
          options: false,
        },
      },
    },
    {
      question_type_id: 11,
      question_type_name: 'YesNo',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Yes',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'No',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 12,
      question_type_name: 'YesNoInverse',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Yes',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
          {
            label: 'No',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 13,
      question_type_name: 'YesNoNA',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Yes',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'No',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
          {
            label: 'N/A',
            action_required: 2,
            action_rule: false,
            score: 'Not Applicable',
            color: 'grey',
          },
        ],
        extras: {},
      },
    },
    {
      question_type_id: 14,
      question_type_name: 'YesNoNaInverse',
      inputs: {
        type: 'radio',
        options: [
          {
            label: 'Yes',
            action_required: 2,
            action_rule: false,
            score: 'Not Compliant',
            color: 'red',
          },
          {
            label: 'No',
            action_required: 3,
            action_rule: false,
            score: 'Compliant',
            color: 'green',
          },
          {
            label: 'N/A',
            action_required: 2,
            action_rule: false,
            score: 'Not Applicable',
            color: 'grey',
          },
        ],
        extras: {},
      },
    },
  ],

  onlyQuestionsType: [
    {
      question_type_id: 1,
      question_type_name: 'ActionlessYesNo',
    },
    {
      question_type_id: 2,
      question_type_name: 'Compliant',
    },
    {
      question_type_id: 3,
      question_type_name: 'Date',
    },
    {
      question_type_id: 4,
      question_type_name: 'Dropdown',
    },
    {
      question_type_id: 5,
      question_type_name: 'MultiAnswer',
    },
    {
      question_type_id: 6,
      question_type_name: 'NumericInput',
    },
    {
      question_type_id: 7,
      question_type_name: 'PcCompliance',
    },
    {
      question_type_id: 8,
      question_type_name: 'RadioRAG',
    },
    {
      question_type_id: 9,
      question_type_name: 'Text',
    },
    {
      question_type_id: 10,
      question_type_name: 'TimePicker',
    },
    {
      question_type_id: 11,
      question_type_name: 'YesNo',
    },
    {
      question_type_id: 12,
      question_type_name: 'YesNoInverse',
    },
    {
      question_type_id: 13,
      question_type_name: 'YesNoNA',
    },
    {
      question_type_id: 14,
      question_type_name: 'YesNoNaInverse',
    },
  ],

  incidentColorCode: {
    1: '#70B4E4',
    2: '#47ADA7',
    3: '#DC4946',
    4: '#EBA235',
    5: '#2D7FBE',
    6: '#2D7FBE',
    7: '#6C8AE4',
    8: '#9D569C',
    9: '#B8BAEB',
    10: '#5C8EDC',
    11: '#3FB27F',
    12: '#E76F51',
    13: '#F4A261',
    14: '#264653',
    15: '#8AB17D',
    16: '#C77DFF',
    17: '#577590',
    18: '#F94144',
    19: '#90BE6D',
    20: '#F8961E',
    21: '#43AA8B',
    22: '#4D96FF',
    23: '#A05195',
    24: '#6A994E',
    25: '#BC4749',

    // NEW UNIQUE COLORS (26–50)

    26: '#FF6B6B', // soft red
    27: '#FFD93D', // bright yellow
    28: '#6BCB77', // light green
    29: '#4D4DFF', // deep indigo
    30: '#FF9F1C', // orange yellow
    31: '#2EC4B6', // aqua
    32: '#E71D36', // crimson
    33: '#FFBF69', // peach
    34: '#3A86FF', // vivid blue
    35: '#8338EC', // electric purple
    36: '#FB5607', // strong orange
    37: '#06D6A0', // neon green
    38: '#118AB2', // ocean blue
    39: '#EF476F', // pink red
    40: '#073B4C', // deep navy teal
    41: '#8ECAE6', // pale sky
    42: '#219EBC', // blue cyan
    43: '#FFB703', // golden yellow
    44: '#D00000', // deep crimson
    45: '#52B788', // soft emerald
    46: '#7400B8', // dark violet
    47: '#80ED99', // pastel green
    48: '#CDB4DB', // pastel purple
    49: '#FFC8DD', // light pink
    50: '#FFAFCC', // rose pink

    // NEW UNIQUE COLORS (51–100)
    51: '#0D1321',
    52: '#1D2D44',
    53: '#3E5C76',
    54: '#748CAB',
    55: '#F0EBD8',
    56: '#132A13',
    57: '#31572C',
    58: '#4F772D',
    59: '#90A955',
    60: '#ECF39E',
    61: '#4C1E4F',
    62: '#724E91',
    63: '#B57EDC',
    64: '#D291BC',
    65: '#FEC8D8',
    66: '#003049',
    67: '#669BBC',
    68: '#FFF3E0',
    69: '#003566',
    70: '#001D3D',
    71: '#FFD60A',
    72: '#FFC300',
    73: '#FF9500',
    74: '#FF5400',
    75: '#9D0208',
    76: '#03071E',
    77: '#FF006E',
    78: '#B5179E',
    79: '#4361EE',
    80: '#4895EF',
    81: '#4CC9F0',
    82: '#90E0EF',
    83: '#CAF0F8',
    84: '#606C38',
    85: '#283618',
    86: '#DDA15E',
    87: '#BC6C25',
    88: '#CCD5AE',
    89: '#E9EDC9',
    90: '#FAEDCD',
    91: '#2B2D42',
    92: '#8D99AE',
    93: '#EDF2F4',
    94: '#EF233C',
    95: '#D90429',
    96: '#8D0801',
    97: '#F48C06',
    98: '#FB8500',
    99: '#E85D04',
    100: '#DC2F02',
  } as Record<number, string>,

  injuryCategoryColorCode: {
    'Category I': '#70B4E4',
    'Category II': '#47ADA7',
    'Category III': '#DC4946',
    Unstageable: '#EBA235',
    'Suspected DTI': '#2D7FBE',
  } as Record<string, string>,

  locationOnBodyColorCode: {
    // 🔴 HEAD REGION (warm red tones)
    face: '#D62828',
    ear: '#E63946',

    // 🟠 UPPER TORSO (orange tones)
    chest: '#F77F00',
    back: '#F4A261',

    // 🟡 LOWER TORSO / HIP
    hip: '#E9C46A',
    groin: '#D4A373',

    // 🔵 ARMS (cool blues)
    arm: '#457B9D',
    elbow: '#1D3557',
    fingers: '#5C8EDC',

    // 🟢 LEGS (greens)
    thigh: '#2A9D8F',
    calf: '#52B788',
    shin: '#40916C',
    ankle: '#74C69D',

    // 🟢 FEET AREA (darker green variation)
    foot: '#2D6A4F',
    heel: '#1B4332',
    sole: '#40916C',
    toes: '#52B788',

    // 🔵 LOWER BACK / SACRAL AREA
    sacrum: '#3A86FF',

    // 🟣 BUTTOCK REGION
    buttock: '#8338EC',
  } as Record<string, string>,

  internalAndCqcRatingsColors: [
    { id: 1, internal: '#E71D36', cqc: '#FF6B6B' },
    { id: 2, internal: '#FF6B9D', cqc: '#FFC93C' },
    { id: 3, internal: '#6BCB77', cqc: '#4D96FF' },
    { id: 4, internal: '#4D96FF', cqc: '#95E1D3' },
    { id: 5, internal: '#9B59B6', cqc: '#F39C12' },
    { id: 6, internal: '#34495E', cqc: '#E74C3C' },
    { id: 7, internal: '#1ABC9C', cqc: '#3498DB' },
    { id: 8, internal: '#2ECC71', cqc: '#E67E22' },
    { id: 9, internal: '#E74C3C', cqc: '#3498DB' },
    { id: 10, internal: '#16A085', cqc: '#8E44AD' },
    { id: 11, internal: '#C0392B', cqc: '#2980B9' },
    { id: 12, internal: '#D35400', cqc: '#27AE60' },
    { id: 13, internal: '#7F8C8D', cqc: '#E91E63' },
    { id: 14, internal: '#2C3E50', cqc: '#00BCD4' },
    { id: 15, internal: '#F39C12', cqc: '#9C27B0' },
    { id: 16, internal: '#1E8449', cqc: '#FFB6C1' },
    { id: 17, internal: '#6A5ACD', cqc: '#FF8C00' },
    { id: 18, internal: '#20B2AA', cqc: '#DC143C' },
    { id: 19, internal: '#FF1493', cqc: '#228B22' },
    { id: 20, internal: '#4169E1', cqc: '#FF4500' },
    { id: 21, internal: '#DAA520', cqc: '#00008B' },
    { id: 22, internal: '#FF69B4', cqc: '#006400' },
    { id: 23, internal: '#00CED1', cqc: '#8B0000' },
    { id: 24, internal: '#9932CC', cqc: '#FF4500' },
    { id: 25, internal: '#00FA9A', cqc: '#4B0082' },
    { id: 26, internal: '#FFD700', cqc: '#DC143C' },
    { id: 27, internal: '#FF8C00', cqc: '#00CED1' },
    { id: 28, internal: '#32CD32', cqc: '#FF1493' },
    { id: 29, internal: '#00BFFF', cqc: '#FFD700' },
    { id: 30, internal: '#FF6347', cqc: '#32CD32' },
    { id: 31, internal: '#1E90FF', cqc: '#FF8C00' },
    { id: 32, internal: '#ADFF2F', cqc: '#1E90FF' },
    { id: 33, internal: '#FF00FF', cqc: '#ADFF2F' },
    { id: 34, internal: '#00FF00', cqc: '#FF00FF' },
    { id: 35, internal: '#FF0000', cqc: '#00FF00' },
    { id: 36, internal: '#0000FF', cqc: '#FF0000' },
    { id: 37, internal: '#00FFFF', cqc: '#0000FF' },
    { id: 38, internal: '#FFFF00', cqc: '#00FFFF' },
    { id: 39, internal: '#7CFC00', cqc: '#FFFF00' },
    { id: 40, internal: '#DC143C', cqc: '#7CFC00' },
    { id: 41, internal: '#00008B', cqc: '#DC143C' },
    { id: 42, internal: '#008B8B', cqc: '#00008B' },
    { id: 43, internal: '#A9A9A9', cqc: '#008B8B' },
    { id: 44, internal: '#006400', cqc: '#A9A9A9' },
    { id: 45, internal: '#355E3B', cqc: '#006400' },
    { id: 46, internal: '#483D8B', cqc: '#355E3B' },
    { id: 47, internal: '#8B4513', cqc: '#483D8B' },
    { id: 48, internal: '#6495ED', cqc: '#8B4513' },
    { id: 49, internal: '#D2691E', cqc: '#6495ED' },
    { id: 50, internal: '#CD5C5C', cqc: '#D2691E' },
    { id: 51, internal: '#FF8C69', cqc: '#CD5C5C' },
    { id: 52, internal: '#8FBC8F', cqc: '#FF8C69' },
    { id: 53, internal: '#FFB6CD', cqc: '#8FBC8F' },
    { id: 54, internal: '#FF69B4', cqc: '#FFB6CD' },
    { id: 55, internal: '#FFB347', cqc: '#FF69B4' },
    { id: 56, internal: '#FF6B9D', cqc: '#FFB347' },
    { id: 57, internal: '#C71585', cqc: '#FF6B9D' },
    { id: 58, internal: '#DB7093', cqc: '#C71585' },
    { id: 59, internal: '#FF1493', cqc: '#DB7093' },
    { id: 60, internal: '#FF69B4', cqc: '#FF1493' },
    { id: 61, internal: '#FFB6C1', cqc: '#FF69B4' },
    { id: 62, internal: '#FFC0CB', cqc: '#FFB6C1' },
    { id: 63, internal: '#FFDAB9', cqc: '#FFC0CB' },
    { id: 64, internal: '#FFE4E1', cqc: '#FFDAB9' },
    { id: 65, internal: '#FFF0F5', cqc: '#FFE4E1' },
    { id: 66, internal: '#FFE4B5', cqc: '#FFF0F5' },
    { id: 67, internal: '#FFDEAD', cqc: '#FFE4B5' },
    { id: 68, internal: '#FFDBAC', cqc: '#FFDEAD' },
    { id: 69, internal: '#FFD700', cqc: '#FFDBAC' },
    { id: 70, internal: '#FFC700', cqc: '#FFD700' },
    { id: 71, internal: '#FFB90F', cqc: '#FFC700' },
    { id: 72, internal: '#FFA500', cqc: '#FFB90F' },
    { id: 73, internal: '#FF8C00', cqc: '#FFA500' },
    { id: 74, internal: '#FF7F50', cqc: '#FF8C00' },
    { id: 75, internal: '#FF6347', cqc: '#FF7F50' },
    { id: 76, internal: '#FF4500', cqc: '#FF6347' },
    { id: 77, internal: '#FF1493', cqc: '#FF4500' },
    { id: 78, internal: '#EE82EE', cqc: '#FF1493' },
    { id: 79, internal: '#DDA0DD', cqc: '#EE82EE' },
    { id: 80, internal: '#DA70D6', cqc: '#DDA0DD' },
    { id: 81, internal: '#BA55D3', cqc: '#DA70D6' },
    { id: 82, internal: '#9932CC', cqc: '#BA55D3' },
    { id: 83, internal: '#8A2BE2', cqc: '#9932CC' },
    { id: 84, internal: '#7B68EE', cqc: '#8A2BE2' },
    { id: 85, internal: '#6A5ACD', cqc: '#7B68EE' },
    { id: 86, internal: '#483D8B', cqc: '#6A5ACD' },
    { id: 87, internal: '#6A0572', cqc: '#483D8B' },
    { id: 88, internal: '#5F4E78', cqc: '#6A0572' },
    { id: 89, internal: '#4C3D68', cqc: '#5F4E78' },
    { id: 90, internal: '#3D2E58', cqc: '#4C3D68' },
    { id: 91, internal: '#2E1E48', cqc: '#3D2E58' },
    { id: 92, internal: '#1E0E38', cqc: '#2E1E48' },
    { id: 93, internal: '#0E0028', cqc: '#1E0E38' },
    { id: 94, internal: '#E71D36', cqc: '#0E0028' },
    { id: 95, internal: '#E74C3C', cqc: '#E71D36' },
    { id: 96, internal: '#C0392B', cqc: '#E74C3C' },
    { id: 97, internal: '#A93226', cqc: '#C0392B' },
    { id: 98, internal: '#92211A', cqc: '#A93226' },
    { id: 99, internal: '#7B241C', cqc: '#92211A' },
    { id: 100, internal: '#641E16', cqc: '#7B241C' },
  ],
};

export const MONTH_ONLY_FORMATS: MatDateFormats = {
  parse: {
    dateInput: 'MM/YYYY',
  },
  display: {
    dateInput: 'MM/YYYY',
    monthYearLabel: 'MMM YYYY',
    dateA11yLabel: 'LL',
    monthYearA11yLabel: 'MMMM YYYY',
  },
};
