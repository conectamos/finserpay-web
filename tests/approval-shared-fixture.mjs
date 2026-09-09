import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
export { loadReissueModule as loadSharedModule };
export const actorModule=loadReissueModule("lib/credit-approval-actor.ts");
export const errors=loadReissueModule("lib/credit-approval-errors.ts");
export const session=loadReissueModule("lib/session.ts",{}, {process:{env:{SESSION_SECRET:"synthetic-shared-approval-secret-for-tests-only",NODE_ENV:"test"}}});
export const shared=loadReissueModule("lib/approval-shared-access.ts",{
  "@/lib/credit-approval-errors":errors,"@/lib/session":session,
});
export const roles=loadReissueModule("lib/roles.ts");
export class TestResponse {
  constructor(body,options={}){this.body=body;this.status=options.status||200;this.headers=new Headers(options.headers);this.cookieValues=new Map();this.cookies={set:(name,value,settings)=>this.cookieValues.set(name,{value,...settings}),delete:name=>this.cookieValues.set(name,{value:"",maxAge:0})};}
  static json(body,options){return new TestResponse(body,options);}
}
