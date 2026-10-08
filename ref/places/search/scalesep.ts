import { IScaleserpResponse } from './types.js'

import axios from 'axios';

export const search = async (params: any): Promise<IScaleserpResponse> =>
    await (await axios.get('https://api.scaleserp.com/search', { params })).data as IScaleserpResponse;

    