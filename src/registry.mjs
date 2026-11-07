import path from 'node:path';
import { existsSync } from 'node:fs';

export const projectNames = [
  'contour-cursor', 'field-camera-lab', 'frame-depth-lab', 'ink-current-portfolio',
  'kinetic-signal-studio', 'launch-ledger', 'night-cinema', 'orbit-archive',
  'pantry-cart', 'postroom-csv', 'profile-launchpad', 'routine-notebook',
  'stride-outfitters', 'video-edit-workbench', 'volt-range-studio',
];

export function registry({ root, project } = {}) {
  const directory = path.resolve(root || process.env.PROJECTS_ROOT || './projects');
  const names = project ? [project] : projectNames;
  if (names.some(name => !projectNames.includes(name))) throw new Error('Unknown project.');
  return names.map(name => {
    const folder = project ? directory : path.join(directory, name);
    return { name, folder, available: existsSync(path.join(folder, 'README.md')),
      kind: name === 'video-edit-workbench' ? 'video' : 'web' };
  });
}

export function selectProject(projects, name) {
  const project = projects.find(project => project.name === name && project.available);
  if (!project) throw new Error('Project is not installed. Clone its repository under PROJECTS_ROOT.');
  return project;
}
