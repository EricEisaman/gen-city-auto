// Registry of vehicle generators. Add new designs here.

import type {VehicleGenerator} from '../types.ts';
import {bus} from './bus.ts';
import {hatchback} from './hatchback.ts';
import {helicopter} from './helicopter.ts';
import {kei} from './kei.ts';
import {sedan} from './sedan.ts';
import {sports} from './sports.ts';
import {suv} from './suv.ts';
import {taxi} from './taxi.ts';
import {train} from './train.ts';
import {truck} from './truck.ts';
import {van} from './van.ts';

export const designs: Record<string, VehicleGenerator> = {
  sedan,
  hatchback,
  kei,
  sports,
  suv,
  taxi,
  van,
  truck,
  bus,
  helicopter,
  train,
};
