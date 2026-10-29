// Registry of vehicle generators. Add new designs here.

import type {VehicleGenerator} from '../types.ts';
import {sedan} from './sedan.ts';

export const designs: Record<string, VehicleGenerator> = {
  sedan,
};
