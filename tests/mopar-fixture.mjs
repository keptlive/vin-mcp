export const moparVin='1D3HW48K55S152258';
export function moparFixture(vin=moparVin, rows=[['RC','S43','STOP DRIVE - PASSENGER AIRBAG INFLATOR','2016-05-24'],['RC','K03','REPROGRAM OCCUPANT RESTRAINT CONTROLLER MODULE','1900-01-01'],['RR','TEST','SERVICE CAMPAIGN','2020-01-01']]) {
 const headers=['VIN Last 8','VIN First 9','ITEM CODE','FAN','RECALL #','DESCRIPTION','RECALL DATE','DEALER CODE','NAME'];
 return '<html><title>Fleet - Recall/Rapid Response Inquiry Result</title><table><tr>'+headers.map(x=>'<th>'+x+'</th>').join('')+'</tr>'+rows.map(([type,id,text,date])=>'<tr>'+[vin.slice(-8),vin.slice(0,9),type,'',id,text,date,'',''].map(x=>'<td class="tableCell"><FONT>'+x+'</FONT></td>').join('')+'</tr>').join('')+'</table><p>Legend : RC-Recall ; RR-Rapid Response</p></html>';
}
