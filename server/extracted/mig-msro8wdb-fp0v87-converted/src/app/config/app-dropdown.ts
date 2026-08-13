export const feedbackStatus = [
  { name: 'Open', value: 1 },
  { name: 'Under Investigation', value: 2 },
  { name: 'Submitted - OPS Review', value: 3 },
  { name: 'Closed', value: 4 },
  { name: 'Submitted - Further Review', value: 5 },
];

export const severityStatus = [
  { name: 'Low', value: 1 },
  { name: 'Medium', value: 2 },
  { name: 'High', value: 3 },
];
export const documentType = [
  {
    name: 'Email',
    type_id: 1,
  },
  {
    name: 'Other',
    type_id: 2,
  },
  {
    name: 'Upload Letter',
    type_id: 3,
  },
];

export const complaintType = [
  { name: 'Concern', value: 1 },
  { name: 'Complaint', value: 2 },
];

export const complaintCategory = [
  { name: 'Care Related', value: 1 },
  { name: 'Housekeeping/Cleanliness of the home', value: 2 },
  { name: 'Staff conduct', value: 3 },
  { name: 'Finance', value: 4 },
  { name: 'Food/Nutrition', value: 5 },
  { name: 'Communication', value: 6 },
  { name: 'Other', value: 7 },
];

export const decisionStatus = [
  { name: 'No', value: 0 },
  { name: 'Yes', value: 1 },
  { name: 'N/A', value: 2 },
];

export const personType = [
  { name: 'Resident', value: 1 },
  { name: 'Relative', value: 2 },
  { name: 'Staff', value: 3 },
  { name: 'Other', value: 4 },
];

export const receivedMode = [
  { name: 'Email', value: 1 },
  { name: 'eReception', value: 2 },
  { name: 'Verbal', value: 3 },
  { name: 'Written', value: 4 },
  { name: 'Other', value: 5 },
];

export const acknowledgementMode = [
  { name: 'Email', value: 1 },
  { name: 'Verbal', value: 2 },
  { name: 'Written', value: 3 },
  { name: 'Other', value: 4 },
];

export const complaintPerson = [
  { name: 'Anonymous', value: 1 },
  { name: 'Employees', value: 2 },
  { name: 'Friend', value: 3 },
  { name: 'Neighbor', value: 4 },
  { name: 'Parents', value: 5 },
  { name: 'Partner', value: 6 },
  { name: 'Resident', value: 7 },
  { name: 'Volunteer', value: 8 },
  { name: 'Other relative', value: 9 },
  { name: 'Other', value: 10 },
  { name: 'Other health and social care professional', value: 11 },
];

export const investigationOutcome = [
  { name: 'Upheld', value: 1 },
  { name: ' Partially upheld', value: 2 },
  { name: ' Not upheld', value: 3 },
];

export const actionStatus = [
  { name: 'Pending', value: 1 },
  { name: 'In Progress', value: 2 },
  { name: 'On Hold', value: 3 },
  { name: 'Completed', value: 4 },
  { name: 'Overdue', value: 5 },
  { name: 'Validated', value: 6 },
];

export const investigationStatus = [
  { name: 'Awaiting Statement', value: 1 },
  { name: 'Being Investigated By External', value: 2 },
];

export const ageGroupOptions = [
  { value: '', label: 'Select' },
  { value: '<1', label: '<1' },
  { value: '1-4', label: '1 – 4' },
  { value: '5-11', label: '5 – 11' },
  { value: '12-15', label: '12 – 15' },
  { value: '16-17', label: '16 – 17' },
  { value: '18-24', label: '18 – 24' },
  { value: '25-34', label: '25 – 34' },
  { value: '35-44', label: '35 – 44' },
  { value: '45-54', label: '45 – 54' },
  { value: '55-64', label: '55 – 64' },
  { value: '65-74', label: '65 – 74' },
  { value: '75-84', label: '75 – 84' },
  { value: '85+', label: '85+' },
];

export const ethnicityOptions = [
  { value: '', label: 'Select' },
  { value: 'White: British', label: 'White: British' },
  { value: 'White: Irish', label: 'White: Irish' },
  { value: 'White Other', label: 'White Other' },
  { value: 'Mixed: White/Black Caribbean', label: 'Mixed: White/Black Caribbean' },
  { value: 'Mixed: White/Black African', label: 'Mixed: White/Black African' },
  { value: 'Mixed: White/Asian', label: 'Mixed: White/Asian' },
  { value: 'Mixed: other mixed background', label: 'Mixed: other mixed background' },
  { value: 'Black or Black British: Caribbean', label: 'Black or Black British: Caribbean' },
  { value: 'Black or Black British: African', label: 'Black or Black British: African' },
  { value: 'Black or Black British: Other', label: 'Black or Black British: Other' },
  { value: 'Asian: Indian', label: 'Asian: Indian' },
  { value: 'Asian: Pakistani', label: 'Asian: Pakistani' },
  { value: 'Asian: Bangladeshi', label: 'Asian: Bangladeshi' },
  { value: 'Asian: Other Asian background', label: 'Asian: Other Asian background' },
  { value: 'Chinese', label: 'Chinese' },
];

export const religionOptions = [
  { value: '', label: 'Select' },
  { value: "Baha'i", label: "Baha'i" },
  { value: 'Buddhist', label: 'Buddhist' },
  { value: 'Christian', label: 'Christian' },
  { value: 'Hindu', label: 'Hindu' },
  { value: 'Jain', label: 'Jain' },
  { value: 'Jewish', label: 'Jewish' },
  { value: 'Muslim', label: 'Muslim' },
  { value: 'Pagan', label: 'Pagan' },
  { value: 'Sikh', label: 'Sikh' },
  { value: 'Zoroastrian', label: 'Zoroastrian' },
  { value: 'None', label: 'None' },
  { value: 'Other', label: 'Other' },
];

export const sexualIdentityOptions = [
  { value: '', label: 'Select' },
  { value: 'Heterosexual/Straight', label: 'Heterosexual/Straight' },
  { value: 'Gay or Lesbian', label: 'Gay or Lesbian' },
  { value: 'Bisexual', label: 'Bisexual' },
  { value: 'Other', label: 'Other' },
  { value: 'Unknown', label: 'Unknown' },
];

export const genderOptions = [
  { value: '', label: 'Select' },
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

export const mockInspectionStatus = [
  { name: 'Draft', value: 1 },
  { name: 'Published', value: 2 },
  { name: 'Assigned to Director', value: 3 },
  { name: 'Reviewed', value: 4 },
  { name: 'Approved', value: 5 },
];

export const mockInspectionOverallRating = [
  { name: 'Unrated', value: 0 },
  { name: 'Inadequate', value: 1 },
  { name: 'Requires Improvement', value: 2 },
  { name: 'Good', value: 3 },
  { name: 'Outstanding', value: 4 },
];

export const auditStatus = [
  { name: 'Overdue', value: 1 },
  { name: 'Not Started', value: 2 },
  { name: 'In Progress', value: 3 },
  { name: 'Completed', value: 4 },
  { name: 'Extended', value: 5 },
  { name: 'Discarded', value: 6 },
];

export const monthlyWeeklyStatus = [
  { name: 'All', value: 0 },
  { name: 'Draft', value: 1 },
  { name: 'Open', value: 2 },
  { name: 'Pending QA Review', value: 3 },
  { name: 'Pending Home Review', value: 4 },
  { name: 'Closed', value: 5 },
];
