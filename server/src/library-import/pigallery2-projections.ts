export const pigallery2Projections = {
  directory_entity: '*',
  media_entity: '*',
  file_entity: '*',
  person_entry: '*',
  person_junction_table: '*',
  album_base_entity: '*',
  user_entity: 'id,name,role,overrideAllowBlockList,allowQuery,blockQuery',
  sharing_entity: 'id,searchQuery,password IS NOT NULL AS has_password,expires,timeStamp,creatorId',
} as const;
