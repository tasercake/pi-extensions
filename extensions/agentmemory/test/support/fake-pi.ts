export function createFakePi(){
 const handlers=new Map<string,Array<(event:any,ctx:any)=>any>>(),tools=new Map<string,any>(),commands=new Map<string,any>(),order:string[]=[];
 const pi={on(name:string,handler:(event:any,ctx:any)=>any){const list=handlers.get(name)??[];list.push(handler);handlers.set(name,list);order.push(`on:${name}`)},registerTool(tool:any){tools.set(tool.name,tool);order.push(`tool:${tool.name}`)},registerCommand(name:string,command:any){commands.set(name,command);order.push(`command:${name}`)}};
 return {pi:pi as any,handlers,tools,commands,order,async emit(name:string,event:any,ctx:any){let out;for(const handler of handlers.get(name)??[])out=await handler(event,ctx);return out;}};
}
export function createContext(options:{mode?:"tui"|"rpc"|"json"|"print";hasUI?:boolean;cwd?:string;sessionId?:string;branch?:any[]}={}){
 const calls:{status:any[];notify:any[]}={status:[],notify:[]};let branch=options.branch??[];
 const ctx:any={mode:options.mode??"tui",hasUI:options.hasUI??true,cwd:options.cwd??"/project",ui:{setStatus:(...x:any[])=>calls.status.push(x),notify:(...x:any[])=>calls.notify.push(x),theme:{fg:(_:string,text:string)=>text}},sessionManager:{getSessionId:()=>options.sessionId??"uuid",getBranch:()=>branch}};
 return {ctx,calls,setBranch:(next:any[])=>{branch=next;}};
}
export const user=(id:string,text:string)=>({id,type:"message",message:{role:"user",content:text}});
export const assistant=(id:string,text:string)=>({id,type:"message",message:{role:"assistant",content:[{type:"text",text}]}});
